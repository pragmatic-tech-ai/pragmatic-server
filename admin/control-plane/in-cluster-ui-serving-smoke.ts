/**
 * GATED real-cluster, real-browser end-to-end smoke for in-cluster UI serving (SP-HIVE UI-serving, Spec 4). OPERATOR-RUN ONLY:
 * NOT a *.test.ts, NOT part of `tsx --test` / `npm test`, never executed by CI.
 *
 * Requires on PATH: `docker`, `kind`, `kubectl`, a running Docker daemon, a FRESH `pragmatic-server:dev` image in the local docker
 * image store, network access to pull `registry:2`, the Playwright Chromium browser, host ports 443 and InClusterRegistry.NodePort
 * (30500) free, and public DNS for `*.localtest.me` (resolves to 127.0.0.1) for the Node-side IdP admin calls. Run with:
 *
 *   npx tsx admin/control-plane/in-cluster-ui-serving-smoke.ts
 *
 * Steps: (1) create a kind cluster with :443 + registry node port mappings and load the server image + registry:2; (2) install
 * ingress-nginx with --enable-ssl-passthrough; (3) apply the in-cluster registry and wait for it; (4) provision the tenant IdP, then
 * compose the real EnvironmentService with a UiDeployActuator pointed at the registry node port; (5) create a federated environment
 * and deploy the Northwind UI bundle to it; (6) drive a real Chromium to /app/<tenant>/northwind/ and assert the marker shell and the
 * asset are served; (7) TAMPER: deploy a second environment, scale it to zero, overwrite its pushed signature companion in the
 * registry with a different signature, scale it back up, and assert the pod never becomes ready and never serves the marker
 * (pod-side verification fails closed); (8) tear everything down (envs, kind cluster, temp dir).
 * WATCH on first run: the unpack init container runs under a read-only root filesystem (only the data PVC is writable), and the
 * dev-signing key must exist in the keysDir the actuator reads.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { BrowserContext } from 'playwright'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { EffectiveRegistry } from './effective-registry.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvType, Template } from './environment-record.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { DockerEnvironmentRuntime } from './environment-runtime.js'
import { EnvironmentRuntimeResolver } from './environment-runtime-resolver.js'
import { EnvironmentService } from './environment-service.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { IdpAdminClient } from './idp-admin-client.js'
import type { IIdpService, IdpConnection } from './idp-service.js'
import { DockerImageDigest } from './image-digest.js'
import { ImageSigner } from './image-signer.js'
import { InClusterEnvironmentRuntime } from './in-cluster-environment-runtime.js'
import { InClusterIdpDriver } from './in-cluster-idp-driver.js'
import { InClusterIdpSeedSource } from './in-cluster-idp-seed.js'
import { InClusterRegistry } from './in-cluster-registry.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KindCli } from './kind.js'
import { FileKeyStore } from './key-store.js'
import { KubectlCli, KubectlError, NodeExecFile } from './kubectl.js'
import { NorthwindUiBundle } from './northwind-ui-bundle.js'
import { OciRegistryClient } from './oci-registry-client.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord, TenantRecord } from './platform-records.js'
import { FileSignatureStore } from './signature-store.js'
import { SeededTenantDirectory } from './tenant-api/seeded-tenant-directory.js'
import { UiArtifact } from './ui-artifact.js'
import { UiArtifactSigner } from './ui-artifact-signer.js'
import { UiDeployActuator } from './ui-deploy-actuator.js'

/** Returns the already-provisioned tenant IdP connection (the in-cluster driver ran in this process). */
class UiSmokeIdpService implements IIdpService
{
    public constructor(private readonly connection: IdpConnection)
    {
    }

    public EnsureForTenant(_tenantId: string, _displayName: string): Promise<IdpConnection>
    {
        return Promise.resolve(this.connection)
    }
}

export class InClusterUiServingSmoke
{
    private static readonly ClusterName = 'uis-smoke'
    private static readonly Context = 'kind-uis-smoke'
    private static readonly TenantId = 'uissmoke'
    private static readonly HiveId = 'uis-hive'
    private static readonly BaseDomain = 'localtest.me'
    private static readonly Image = 'pragmatic-server:dev'
    private static readonly SigningKeyRef = 'dev-signing'
    private static readonly EnvName = 'uis-env'
    private static readonly TamperEnvName = 'uis-env-tamper'
    private static readonly AppName = 'northwind'
    private static readonly HttpsPort = 443
    private static readonly ExternalScheme = 'https'
    private static readonly SchemeSeparator = '://'
    private static readonly OciScheme = 'http://'
    private static readonly EnvPortFloor = 8100
    private static readonly Docker = 'docker'
    private static readonly PullVerb = 'pull'

    private static readonly IngressManifestUrl = 'https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/kind/deploy.yaml'
    private static readonly HostResolverFlag = '--host-resolver-rules='
    private static readonly MapPrefix = 'MAP '
    private static readonly MapSuffix = ' 127.0.0.1'
    private static readonly RuleSeparator = ', '
    private static readonly IngressNamespace = 'ingress-nginx'
    private static readonly IngressDeployment = 'ingress-nginx-controller'
    private static readonly PassthroughPatch = '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--enable-ssl-passthrough"}]'
    private static readonly ControllerSelector = 'app.kubernetes.io/component=controller'
    private static readonly WaitTimeout = '--timeout=240s'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly NamespaceFlag = '-n'
    private static readonly ApplyVerb = 'apply'
    private static readonly FileFlag = '-f'
    private static readonly PatchVerb = 'patch'
    private static readonly DeploymentKind = 'deployment'
    private static readonly TypeFlag = '--type=json'
    private static readonly PatchFlag = '-p'
    private static readonly WaitVerb = 'wait'
    private static readonly ReadyCondition = '--for=condition=ready'
    private static readonly PodKind = 'pod'
    private static readonly SelectorFlag = '--selector='
    private static readonly DeploymentResourcePrefix = 'deployment/'
    private static readonly Utf8 = 'utf8'
    private static readonly Ed25519 = 'ed25519'
    private static readonly Pem = 'pem'
    private static readonly Spki = 'spki'
    private static readonly Pkcs8 = 'pkcs8'
    private static readonly EpochIso = '1970-01-01T00:00:00.000Z'
    private static readonly TempPrefix = 'uis-smoke-'
    private static readonly KeysDirName = 'keys'
    private static readonly SignaturesFileName = 'signatures.json'
    private static readonly RegistryFileName = 'environments.json'

    private static readonly AppPathPrefix = '/app/'
    private static readonly PathSeparator = '/'
    private static readonly AssetRelativePath = 'assets/app.js'
    private static readonly HttpOk = 200
    private static readonly StatusKey = 'status'
    private static readonly ReadyReplicasKey = 'readyReplicas'
    private static readonly NoReplicas = 0
    private static readonly OneReplica = 1
    private static readonly PageWaitMs = 60000
    private static readonly NotReadyWindowMs = 90000
    private static readonly NotReadyPollMs = 5000
    private static readonly TamperSignatureBytes = 64
    private static readonly Base64 = 'base64'
    private static readonly NoDetail = ''

    private static readonly RetryAttempts = 30
    private static readonly RetryIntervalMs = 2000

    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly TeardownWarn = 'WARN best-effort teardown failed for '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly ExitOk = 0
    private static readonly ExitFail = 1
    private static readonly Labels = {
        Cluster: 'kind cluster created with the :443 + registry node port mappings; server image and registry:2 loaded',
        Ingress: 'ingress-nginx installed with --enable-ssl-passthrough and ready',
        Registry: 'in-cluster registry applied and the Deployment rolled out',
        Idp: 'tenant IdP provisioned in-cluster with a browser base domain',
        Env: 'env created in-cluster and federated to the tenant IdP',
        Deployed: 'northwind UI bundle deployed (pushed, signed, rolled out) via DeployAppToEnvironment',
        ServedShell: 'browser: /app/<tenant>/northwind/ is served and the body carries the marker',
        ServedAsset: 'browser: /app/<tenant>/northwind/assets/app.js returns 200 with the asset body',
        TamperEnv: 'tamper env created and deployed cleanly before tampering',
        TamperInjected: 'tamper: signature companion overwritten in the registry while the env was scaled to zero',
        TamperNotReady: 'tamper: Deployment never became ready within the bounded window (pod-side verify fail-closed)',
        TamperNotServed: 'tamper: /app/<tenant>/northwind/ does NOT serve the marker',
    }

    private failed = false
    private tempDir: string | undefined
    private readonly exec = new NodeExecFile()
    private readonly kind = new KindCli(this.exec)
    private readonly kubectl = new KubectlCli(InClusterUiServingSmoke.Context, this.exec)

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }

    public static async Main(): Promise<void>
    {
        const S = InClusterUiServingSmoke
        const ok = await new InClusterUiServingSmoke().Run()
        console.log(ok ? S.OverallPass : S.OverallFail)
        process.exitCode = ok ? S.ExitOk : S.ExitFail
    }

    /** Chromium host-resolver rules mapping both env browser hosts to loopback, derived from the name constants. */
    private static HostResolverRules(): string
    {
        const S = InClusterUiServingSmoke
        const hosts = [
            K8sManifestBuilder.EnvBrowserHostOf(S.EnvName, S.BaseDomain),
            K8sManifestBuilder.EnvBrowserHostOf(S.TamperEnvName, S.BaseDomain),
        ]
        return S.HostResolverFlag + hosts.map(h => S.MapPrefix + h + S.MapSuffix).join(S.RuleSeparator)
    }

    public async Run(): Promise<boolean>
    {
        const S = InClusterUiServingSmoke
        let service: EnvironmentService | undefined
        const created: string[] = []
        try
        {
            this.tempDir = await mkdtemp(join(tmpdir(), S.TempPrefix))
            await this.exec.Run(S.Docker, [S.PullVerb, InClusterRegistry.Image])
            await this.kind.CreateCluster(S.ClusterName, { extraPortMappings: [S.HttpsPort, InClusterRegistry.NodePort] })
            await this.kind.LoadImage(S.Image, S.ClusterName)
            await this.kind.LoadImage(InClusterRegistry.Image, S.ClusterName)
            this.Expect(S.Labels.Cluster, true)

            await this.InstallIngress()
            this.Expect(S.Labels.Ingress, true)

            await this.kubectl.Apply(new K8sManifestBuilder().RenderRegistry(S.HiveId))
            await this.kubectl.RolloutStatus(InClusterRegistry.Namespace, InClusterRegistry.RegistryName)
            this.Expect(S.Labels.Registry, true)

            const seeds = new InClusterIdpSeedSource(undefined, S.BaseDomain)
            const idpDriver = new InClusterIdpDriver(this.kubectl, new K8sManifestBuilder(), seeds, S.HiveId, S.Image)
            const result = await idpDriver.EnsureRunning({ tenantId: S.TenantId, displayName: S.TenantId, takenPorts: [] })
            const connection = result.connection
            this.Expect(S.Labels.Idp, connection.baseDomain === S.BaseDomain && connection.browserBaseUrl.includes(S.BaseDomain), connection.browserBaseUrl)
            const adminClient = new IdpAdminClient({ baseUrl: connection.browserBaseUrl, adminToken: connection.adminToken, ca: connection.ca })
            await this.Retry(async () =>
            {
                await adminClient.EnsureRealm(S.TenantId, S.TenantId)
            })

            service = await this.ComposeService(connection, adminClient)
            await service.Create(S.EnvName, Template.DevBlank, EnvType.Development, undefined, S.HiveId)
            created.push(S.EnvName)
            this.Expect(S.Labels.Env, true)
            await service.DeployAppToEnvironment(S.EnvName, NorthwindUiBundle.Load())
            this.Expect(S.Labels.Deployed, true)

            const browser = await chromium.launch({ args: [S.HostResolverRules()] })
            try
            {
                const context = await browser.newContext({ ignoreHTTPSErrors: true })
                await this.AssertServed(context, S.EnvName)
                await this.AssertTampered(service, context, created)
            }
            finally
            {
                await browser.close()
            }
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + KubectlError.Redact(err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            for (const name of created)
            {
                await this.BestEffort(name, async () =>
                {
                    await service?.Delete(name)
                })
            }
            await this.BestEffort(S.ClusterName, async () =>
            {
                await this.kind.DeleteCluster(S.ClusterName)
            })
            if (this.tempDir !== undefined)
            {
                const dir = this.tempDir
                await this.BestEffort(dir, async () =>
                {
                    await rm(dir, { recursive: true, force: true })
                })
            }
        }
        return !this.failed
    }

    /** Serve assertion: the shell page carries the marker and the asset is fetched with its body. */
    private async AssertServed(context: BrowserContext, envName: string): Promise<void>
    {
        const S = InClusterUiServingSmoke
        const page = await context.newPage()
        const url = this.AppUrl(envName)
        const response = await this.Retry(async () =>
        {
            const r = await page.goto(url, { timeout: S.PageWaitMs })
            if (r === null || r.status() !== S.HttpOk)
            {
                throw new Error(String(r?.status()))
            }
            return r
        })
        const body = await response.text()
        this.Expect(S.Labels.ServedShell, body.includes(NorthwindUiBundle.Marker), String(response.status()))
        const asset = await context.request.get(url + S.AssetRelativePath)
        const assetBody = await asset.text()
        this.Expect(S.Labels.ServedAsset, asset.status() === S.HttpOk && assetBody.includes(NorthwindUiBundle.Marker), String(asset.status()))
        await page.close()
    }

    /**
     * Tamper case: deploy a second env cleanly, scale it to zero (so no healthy old pod can mask the result), overwrite the pushed
     * signature companion with a different (well-formed base64, wrong) signature, scale back up, then require that the Deployment
     * never becomes ready and that the marker is never served.
     */
    private async AssertTampered(service: EnvironmentService, context: BrowserContext, created: string[]): Promise<void>
    {
        const S = InClusterUiServingSmoke
        await service.Create(S.TamperEnvName, Template.DevBlank, EnvType.Development, undefined, S.HiveId)
        created.push(S.TamperEnvName)
        const bundle = NorthwindUiBundle.Load()
        await service.DeployAppToEnvironment(S.TamperEnvName, bundle)
        this.Expect(S.Labels.TamperEnv, true)

        const namespace = K8sManifestBuilder.NamespaceOf(S.TamperEnvName)
        const deployment = K8sManifestBuilder.ServerDeploymentOf(S.TamperEnvName)
        await this.kubectl.Scale(namespace, deployment, S.NoReplicas)

        const oci = new OciRegistryClient(S.OciScheme + InClusterRegistry.PushBase())
        const repo = UiDeployActuator.RepoOf(S.Hive(), bundle.config.appName)
        const sigTag = UiDeployActuator.ArtifactTagOf(bundle.config.appName, bundle.config.appVersion) + UiArtifact.SignatureTagSuffix
        await this.TamperSignature(oci, repo, sigTag)
        this.Expect(S.Labels.TamperInjected, true)

        await this.kubectl.Scale(namespace, deployment, S.OneReplica)
        const everReady = await this.BecomesReady(namespace, deployment)
        this.Expect(S.Labels.TamperNotReady, !everReady)
        this.Expect(S.Labels.TamperNotServed, !(await this.ServesMarker(context, S.TamperEnvName)))
    }

    /** Replaces the signature companion manifest with one whose single layer carries a different base64 signature. */
    private async TamperSignature(oci: OciRegistryClient, repo: string, sigTag: string): Promise<void>
    {
        const S = InClusterUiServingSmoke
        const encoder = new TextEncoder()
        const existing = JSON.parse(new TextDecoder().decode(await oci.PullManifest(repo, sigTag))) as { config: unknown; layers: Record<string, unknown>[] }
        const wrong = encoder.encode(randomBytes(S.TamperSignatureBytes).toString(S.Base64))
        const wrongDigest = await oci.PushBlob(repo, wrong)
        const layers = existing.layers.map(layer => ({ ...layer, digest: wrongDigest, size: wrong.byteLength }))
        await oci.PushManifest(repo, sigTag, encoder.encode(JSON.stringify({ ...existing, layers })))
    }

    /** Polls the Deployment's readyReplicas for the bounded window; true if it ever reaches ready. */
    private async BecomesReady(namespace: string, deployment: string): Promise<boolean>
    {
        const S = InClusterUiServingSmoke
        const deadline = Date.now() + S.NotReadyWindowMs
        while (Date.now() < deadline)
        {
            const json = JSON.parse(await this.kubectl.Get(namespace, S.DeploymentResourcePrefix + deployment)) as Record<string, Record<string, unknown> | undefined>
            const ready = json[S.StatusKey]?.[S.ReadyReplicasKey]
            if (typeof ready === 'number' && ready > S.NoReplicas)
            {
                return true
            }
            await new Promise<void>(resolve => setTimeout(resolve, S.NotReadyPollMs))
        }
        return false
    }

    /** True only if the app URL answers 200 with the marker; connection errors and non-200s count as not served. */
    private async ServesMarker(context: BrowserContext, envName: string): Promise<boolean>
    {
        const S = InClusterUiServingSmoke
        try
        {
            const response = await context.request.get(this.AppUrl(envName))
            return response.status() === S.HttpOk && (await response.text()).includes(NorthwindUiBundle.Marker)
        }
        catch
        {
            return false
        }
    }

    private AppUrl(envName: string): string
    {
        const S = InClusterUiServingSmoke
        return S.ExternalScheme + S.SchemeSeparator + K8sManifestBuilder.EnvBrowserHostOf(envName, S.BaseDomain)
            + S.AppPathPrefix + S.TenantId + S.PathSeparator + S.AppName + S.PathSeparator
    }

    /** Applies the kind-flavoured ingress-nginx, turns on SSL passthrough on the controller, and waits for it. */
    private async InstallIngress(): Promise<void>
    {
        const S = InClusterUiServingSmoke
        await this.Kubectl([S.ApplyVerb, S.FileFlag, S.IngressManifestUrl])
        await this.Kubectl([S.PatchVerb, S.DeploymentKind, S.IngressDeployment, S.NamespaceFlag, S.IngressNamespace, S.TypeFlag, S.PatchFlag, S.PassthroughPatch])
        await this.Kubectl([S.WaitVerb, S.NamespaceFlag, S.IngressNamespace, S.ReadyCondition, S.PodKind, S.SelectorFlag + S.ControllerSelector, S.WaitTimeout])
    }

    /** The real EnvironmentService wired as the tenant-admin pod wires it, plus a UiDeployActuator against the registry node port. */
    private async ComposeService(connection: IdpConnection, adminClient: IdpAdminClient): Promise<EnvironmentService>
    {
        const S = InClusterUiServingSmoke
        const dataRoot = this.tempDir as string
        const keysDir = join(dataRoot, S.KeysDirName)
        await mkdir(keysDir, { recursive: true })
        const pair = generateKeyPairSync(S.Ed25519)
        await writeFile(join(keysDir, S.SigningKeyRef + FileKeyStore.PublicSuffix), pair.publicKey.export({ type: S.Spki, format: S.Pem }), S.Utf8)
        await writeFile(join(keysDir, S.SigningKeyRef + FileKeyStore.PrivateSuffix), pair.privateKey.export({ type: S.Pkcs8, format: S.Pem }), S.Utf8)
        const keys = new FileKeyStore(keysDir)
        const hive = S.Hive()
        const signatures = new FileSignatureStore(join(dataRoot, S.SignaturesFileName))
        await new ImageSigner(new DockerImageDigest(), signatures, keys).Sign(EffectiveRegistry.For(hive).ImageRef(S.Image), S.SigningKeyRef)
        const directory = new SeededTenantDirectory({ tenant: S.Tenant(), hives: [hive] })
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(dataRoot, S.RegistryFileName), docker)
        await registry.Load()
        const orchestrators = new HiveOrchestratorFactory(S.Context, dataRoot)
        const placement = new EnvironmentPlacement(directory)
        const actuator = new UiDeployActuator(new OciRegistryClient(S.OciScheme + InClusterRegistry.PushBase()), new UiArtifactSigner(keys), keys, orchestrators, new K8sManifestBuilder(), registry)
        return new EnvironmentService(
            registry,
            new PortAllocator(S.EnvPortFloor, new NetPortProbe()),
            new EnvironmentRuntimeResolver(new DockerEnvironmentRuntime(docker, new BundleBuilderAdapter()), new InClusterEnvironmentRuntime(orchestrators, placement, directory, new BundleBuilderAdapter()), directory, orchestrators),
            new UserSeederAdapter(new UserSeeder()),
            dataRoot,
            new AdminProxy(new WsAdminConnector()),
            directory,
            new UiSmokeIdpService(connection),
            () => adminClient,
            actuator)
    }

    private async Kubectl(args: string[]): Promise<void>
    {
        const S = InClusterUiServingSmoke
        try
        {
            await this.exec.Run(S.Kubectl, [S.ContextFlag, S.Context, ...args])
        }
        catch (e: unknown)
        {
            const err = e as { stderr?: unknown; message?: unknown }
            throw new KubectlError(typeof err.stderr === 'string' && err.stderr.length > 0 ? err.stderr : String(err.message ?? e))
        }
    }

    private async Retry<T>(action: () => Promise<T>): Promise<T>
    {
        const S = InClusterUiServingSmoke
        let last: unknown
        for (let attempt = 0; attempt < S.RetryAttempts; attempt++)
        {
            try
            {
                return await action()
            }
            catch (err)
            {
                last = err
                await new Promise<void>(resolve => setTimeout(resolve, S.RetryIntervalMs))
            }
        }
        throw last
    }

    private async BestEffort(what: string, action: () => Promise<void>): Promise<void>
    {
        const S = InClusterUiServingSmoke
        try
        {
            await action()
        }
        catch (err)
        {
            console.log(S.TeardownWarn + what + S.DetailSep + KubectlError.Redact(err instanceof Error ? err.message : String(err)))
        }
    }

    private Expect(label: string, ok: boolean, detail: string = InClusterUiServingSmoke.NoDetail): void
    {
        const S = InClusterUiServingSmoke
        if (!ok)
        {
            this.failed = true
        }
        console.log((ok ? S.PassTag : S.FailTag) + label + (detail !== S.NoDetail && !ok ? S.DetailSep + detail : S.NoDetail))
    }

    private static Tenant(): TenantRecord
    {
        const S = InClusterUiServingSmoke
        return { id: S.TenantId, clientId: S.TenantId, displayName: S.TenantId, createdAt: S.EpochIso }
    }

    private static Hive(): HiveRecord
    {
        const S = InClusterUiServingSmoke
        return {
            id: S.HiveId,
            tenantId: S.TenantId,
            displayName: S.HiveId,
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: S.Context },
            registry: { mode: InfraMode.Attach },
            trustRootRef: S.SigningKeyRef,
            createdAt: S.EpochIso,
        }
    }
}

if (InClusterUiServingSmoke.IsEntryPoint())
{
    await InClusterUiServingSmoke.Main()
}
