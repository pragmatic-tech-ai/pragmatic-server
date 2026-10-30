/**
 * GATED real-cluster, real-browser smoke for in-cluster split-host IdP federation (SP-HIVE-6c). OPERATOR-RUN ONLY: NOT a
 * *.test.ts, NOT part of `tsx --test` / `npm test`, never executed by CI. Supersedes the retired Docker-era idp-federation-smoke.
 *
 * Requires on PATH: `kind`, `kubectl`, a running Docker daemon, a FRESH `pragmatic-server:dev` image in the local docker image
 * store (loaded onto the kind node), the Playwright Chromium browser, host port 443 free, and public DNS for `*.localtest.me`
 * (resolves to 127.0.0.1) for the Node-side IdP admin calls. Run with:
 *
 *   npx tsx admin/control-plane/in-cluster-federation-smoke.ts
 *
 * Steps: (1) create a kind cluster with a :443 extraPortMapping; (2) install ingress-nginx with --enable-ssl-passthrough;
 * (3) provision the tenant IdP in-cluster (dual-SAN cert: Service-DNS + idp-<tenant>.<baseDomain>) and seed a realm + owner;
 * (4) deploy the tenant-admin pod via TenantAdminBootstrap (spec.idp populated; it mounts a ca.crt-ONLY Secret and an
 * admin-token Secret, never the IdP TLS Secret) and check it over a kubectl port-forward; (5) create two hive-bound environments
 * through the real EnvironmentService (each federates to the tenant IdP and is reached through its TLS-terminating Ingress host);
 * (6) drive a real Playwright browser (host-resolver MAP idp-<tenant>.<baseDomain> and <env>.<baseDomain> to 127.0.0.1,
 * ignoreHTTPSErrors) through a full OIDC login at env A, assert /auth/session carries email + name, then env B rides the IdP SSO
 * cookie with NO second login form; (7) tear everything down (envs, kind cluster, temp dir). Secrets are never printed.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { BrowserContext, Page } from 'playwright'
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
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KindCli } from './kind.js'
import { FileKeyStore } from './key-store.js'
import { KubectlCli, KubectlError, NodeExecFile } from './kubectl.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord, TenantRecord } from './platform-records.js'
import { FileSignatureStore } from './signature-store.js'
import { TenantAdminBootstrap } from './tenant-admin-bootstrap.js'
import type { IHiveRegistrar } from './tenant-admin-bootstrap.js'
import { SeededTenantDirectory } from './tenant-api/seeded-tenant-directory.js'

/** Hands out a throwaway agent bearer; this smoke does not run a platform agent channel. */
class SmokeRegistrar implements IHiveRegistrar
{
    private static readonly TokenBytes = 16
    private static readonly Hex = 'hex'

    public RegisterHive(_hiveId: string): Promise<string>
    {
        return Promise.resolve(randomBytes(SmokeRegistrar.TokenBytes).toString(SmokeRegistrar.Hex))
    }
}

/** Returns the already-provisioned tenant IdP connection (the in-cluster driver ran in this process). */
class SmokeIdpService implements IIdpService
{
    public constructor(private readonly connection: IdpConnection)
    {
    }

    public async ConnectForTenant(_tenantId: string): Promise<IdpConnection | undefined>
    {
        return undefined
    }

    public async TeardownForTenant(_tenantId: string): Promise<void>
    {
    }

    public EnsureForTenant(_tenantId: string, _displayName: string): Promise<IdpConnection>
    {
        return Promise.resolve(this.connection)
    }
}

export class InClusterFederationSmoke
{
    private static readonly ClusterName = 'icf-smoke'
    private static readonly Context = 'kind-icf-smoke'
    private static readonly TenantId = 'icfsmoke'
    private static readonly HiveId = 'icf-hive'
    private static readonly BaseDomain = 'localtest.me'
    private static readonly Image = 'pragmatic-server:dev'
    private static readonly SigningKeyRef = 'dev-signing'
    private static readonly EnvAName = 'icf-env-a'
    private static readonly EnvBName = 'icf-env-b'
    private static readonly OwnerEmail = 'owner@icfsmoke.test'
    private static readonly OwnerName = 'Smoke Owner'
    private static readonly OwnerPrincipal = 'owner'
    private static readonly PasswordBytes = 12
    private static readonly Hex = 'hex'
    private static readonly HttpsPort = 443
    private static readonly TenantPlanePort = 8443
    private static readonly IdpPort = 9443
    private static readonly ExternalScheme = 'https'
    private static readonly ChannelUrl = 'http://channel.invalid:7000'
    private static readonly IdpTokenRef = 'admin-token'
    private static readonly EnvPortFloor = 8100

    private static readonly IngressManifestUrl = 'https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/kind/deploy.yaml'
    private static readonly HostResolverFlag = '--host-resolver-rules='
    private static readonly MapPrefix = 'MAP '
    private static readonly MapSuffix = ' 127.0.0.1'
    private static readonly RuleSeparator = ', '
    private static readonly Unreachable = 'unreachable'
    private static readonly SchemeSeparator = '://'
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
    private static readonly PortForwardVerb = 'port-forward'
    private static readonly ServicePrefix = 'service/'
    private static readonly AutoLocalPort = ':'
    private static readonly ForwardingPattern = /127\.0\.0\.1:(\d+)/
    private static readonly DataEvent = 'data'
    private static readonly ErrorEvent = 'error'
    private static readonly SigTerm = 'SIGTERM'
    private static readonly ForwardTimeoutMs = 30000
    private static readonly ForwardTimeoutMessage = 'port-forward did not become ready in time'
    private static readonly HealthPath = '/healthz'
    private static readonly LoopbackHttp = 'http://127.0.0.1:'
    private static readonly Utf8 = 'utf8'
    private static readonly Ed25519 = 'ed25519'
    private static readonly Pem = 'pem'
    private static readonly Spki = 'spki'
    private static readonly Pkcs8 = 'pkcs8'
    private static readonly EpochIso = '1970-01-01T00:00:00.000Z'
    private static readonly TempPrefix = 'icf-smoke-'
    private static readonly KeysDirName = 'keys'
    private static readonly SignaturesFileName = 'signatures.json'
    private static readonly RegistryFileName = 'environments.json'

    /** Chromium host-resolver rules mapping the IdP + both env browser hosts to loopback, derived from the name
     *  constants so they can never drift from the rendered Ingress hosts. */
    private static HostResolverRules(): string
    {
        const S = InClusterFederationSmoke
        const hosts = [
            K8sManifestBuilder.IdpBrowserHostOf(S.TenantId, S.BaseDomain),
            K8sManifestBuilder.EnvBrowserHostOf(S.EnvAName, S.BaseDomain),
            K8sManifestBuilder.EnvBrowserHostOf(S.EnvBName, S.BaseDomain),
        ]
        return S.HostResolverFlag + hosts.map(h => S.MapPrefix + h + S.MapSuffix).join(S.RuleSeparator)
    }
    private static readonly BeginPath = '/auth/oidc/begin?environment='
    private static readonly SessionPath = '/auth/session'
    private static readonly CallbackPathFragment = '/auth/oidc/callback'
    private static readonly SessionCookieName = 'ps_session'
    private static readonly CookieJoin = '='
    private static readonly TokenSep = '.'
    private static readonly TokenKey = 'token'
    private static readonly EmailKey = 'email'
    private static readonly NameKey = 'name'
    private static readonly EmailSelector = 'input[name=email]'
    private static readonly PasswordSelector = 'input[name=password]'
    private static readonly SubmitSelector = 'button[type=submit]'
    private static readonly BodySelector = 'body'
    private static readonly CookieHeader = 'cookie'
    private static readonly FormWaitMs = 30000
    private static readonly CallbackWaitMs = 45000
    private static readonly SsoSettleMs = 1500

    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly TeardownWarn = 'WARN best-effort teardown failed for '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly Labels = {
        Cluster: 'kind cluster created with the :443 mapping and the image loaded',
        Ingress: 'ingress-nginx installed with --enable-ssl-passthrough and ready',
        Idp: 'tenant IdP provisioned in-cluster with a dual-SAN cert and a browser base domain',
        Realm: 'realm + owner account seeded through the IdP Ingress (passthrough)',
        TenantAdmin: 'tenant-admin pod rolled out with spec.idp (ca.crt-only + admin-token Secrets) and is healthy over port-forward',
        EnvA: 'env A created in-cluster and federated to the tenant IdP',
        EnvB: 'env B created in-cluster and federated to the tenant IdP',
        LoginForm: 'env A: browser redirected to the IdP host and the login form rendered',
        SessionA: 'env A: full OIDC login; /auth/session carries email + name',
        Sso: 'env B: rode the IdP SSO cookie with NO login form',
        SessionB: 'env B: /auth/session carries the same email + name',
    }

    private failed = false
    private tempDir: string | undefined
    private forward: ChildProcess | undefined
    private readonly exec = new NodeExecFile()
    private readonly kind = new KindCli(this.exec)
    private readonly kubectl = new KubectlCli(InClusterFederationSmoke.Context)

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }

    public static async Main(): Promise<void>
    {
        const ok = await new InClusterFederationSmoke().Run()
        console.log(ok ? InClusterFederationSmoke.OverallPass : InClusterFederationSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = InClusterFederationSmoke
        let service: EnvironmentService | undefined
        const created: string[] = []
        try
        {
            this.tempDir = await mkdtemp(join(tmpdir(), S.TempPrefix))
            await this.kind.CreateCluster(S.ClusterName, { extraPortMappings: [S.HttpsPort] })
            await this.kind.LoadImage(S.Image, S.ClusterName)
            this.Expect(S.Labels.Cluster, true)

            await this.InstallIngress()
            this.Expect(S.Labels.Ingress, true)

            const seeds = new InClusterIdpSeedSource(undefined, S.BaseDomain)
            const idpDriver = new InClusterIdpDriver(this.kubectl, new K8sManifestBuilder(), seeds, S.HiveId, S.Image)
            const result = await idpDriver.EnsureRunning({ tenantId: S.TenantId, displayName: S.TenantId, takenPorts: [] })
            const connection = result.connection
            this.Expect(S.Labels.Idp, connection.baseDomain === S.BaseDomain && connection.browserBaseUrl.includes(S.BaseDomain), connection.browserBaseUrl)

            const adminClient = new IdpAdminClient({ baseUrl: connection.browserBaseUrl, adminToken: connection.adminToken, ca: connection.ca })
            const password = randomBytes(S.PasswordBytes).toString(S.Hex)
            await this.Retry(async () =>
            {
                await adminClient.EnsureRealm(S.TenantId, S.TenantId)
            })
            await adminClient.SeedAccount(S.TenantId, { email: S.OwnerEmail, principalId: S.OwnerPrincipal, displayName: S.OwnerName, password })
            this.Expect(S.Labels.Realm, true)

            await this.DeployTenantAdmin(connection)
            this.Expect(S.Labels.TenantAdmin, true)

            service = await this.ComposeService(connection, adminClient)
            await service.Create(S.EnvAName, Template.DevBlank, EnvType.Development, undefined, S.HiveId)
            created.push(S.EnvAName)
            this.Expect(S.Labels.EnvA, true)
            await service.Create(S.EnvBName, Template.DevBlank, EnvType.Development, undefined, S.HiveId)
            created.push(S.EnvBName)
            this.Expect(S.Labels.EnvB, true)

            await this.DriveBrowser(password)
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + KubectlError.Redact(err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            this.StopForward()
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

    /** Applies the kind-flavoured ingress-nginx, turns on SSL passthrough on the controller, and waits for it. */
    private async InstallIngress(): Promise<void>
    {
        const S = InClusterFederationSmoke
        await this.Kubectl([S.ApplyVerb, S.FileFlag, S.IngressManifestUrl])
        await this.Kubectl([S.PatchVerb, S.DeploymentKind, S.IngressDeployment, S.NamespaceFlag, S.IngressNamespace, S.TypeFlag, S.PatchFlag, S.PassthroughPatch])
        await this.Kubectl([S.WaitVerb, S.NamespaceFlag, S.IngressNamespace, S.ReadyCondition, S.PodKind, S.SelectorFlag + S.ControllerSelector, S.WaitTimeout])
    }

    /** Renders the tenant-admin bootstrap with the minted IdP material, applies it, and proves the pod is healthy over a port-forward. */
    private async DeployTenantAdmin(connection: IdpConnection): Promise<void>
    {
        const S = InClusterFederationSmoke
        const pair = generateKeyPairSync(S.Ed25519)
        const trustRoot = pair.publicKey.export({ type: S.Spki, format: S.Pem }).toString()
        const bootstrap = await new TenantAdminBootstrap(new SmokeRegistrar()).GenerateBootstrap({
            tenant: InClusterFederationSmoke.Tenant(),
            hive: InClusterFederationSmoke.Hive(),
            tenantAdminImage: S.Image,
            tenantPlanePort: S.TenantPlanePort,
            baseDomain: S.BaseDomain,
            externalScheme: S.ExternalScheme,
            channelUrl: S.ChannelUrl,
            idp: {
                image: S.Image,
                port: S.IdpPort,
                tlsSecretName: InClusterIdpSeedSource.TlsSecretNameOf(S.TenantId),
                adminTokenSecretName: InClusterIdpSeedSource.AdminSecretNameOf(S.TenantId),
                adminTokenRef: S.IdpTokenRef,
                ca: connection.ca,
                adminToken: connection.adminToken,
            },
            trustRootPublicKey: trustRoot,
        })
        await this.kubectl.Apply(bootstrap.manifest)
        await this.kubectl.Apply(bootstrap.secrets.RenderManifest())
        const name = K8sManifestBuilder.TenantAdminNameOf(S.TenantId)
        await this.kubectl.RolloutStatus(K8sManifestBuilder.SystemNamespace, name)
        this.forward = this.StartForward(K8sManifestBuilder.SystemNamespace, name, S.TenantPlanePort)
        const port = await InClusterFederationSmoke.LocalPortOf(this.forward)
        const status = await this.Retry(async () => this.HealthStatus(port))
        if (status !== InClusterFederationSmoke.HealthOk)
        {
            throw new Error(InClusterFederationSmoke.HealthFailed + String(status))
        }
    }

    private static readonly HealthOk = 200
    private static readonly HealthFailed = 'tenant-admin /healthz status '
    private static readonly RetryAttempts = 30
    private static readonly RetryIntervalMs = 2000

    private async HealthStatus(port: number): Promise<number>
    {
        const S = InClusterFederationSmoke
        // The tenant plane serves plain HTTP behind the pod's Service; TLS is the Ingress's concern.
        const response = await fetch(S.LoopbackHttp + String(port) + S.HealthPath).catch(() => undefined)
        if (response === undefined)
        {
            throw new Error(S.HealthFailed + S.Unreachable)
        }
        return response.status
    }

    /** The real EnvironmentService, wired as the tenant-admin pod wires it, but with the IdP admin client reaching the IdP through its Ingress. */
    private async ComposeService(connection: IdpConnection, adminClient: IdpAdminClient): Promise<EnvironmentService>
    {
        const S = InClusterFederationSmoke
        const dataRoot = this.tempDir as string
        const keysDir = join(dataRoot, S.KeysDirName)
        await mkdir(keysDir, { recursive: true })
        const pair = generateKeyPairSync(S.Ed25519)
        await writeFile(join(keysDir, S.SigningKeyRef + FileKeyStore.PublicSuffix), pair.publicKey.export({ type: S.Spki, format: S.Pem }), S.Utf8)
        await writeFile(join(keysDir, S.SigningKeyRef + FileKeyStore.PrivateSuffix), pair.privateKey.export({ type: S.Pkcs8, format: S.Pem }), S.Utf8)
        const hive = InClusterFederationSmoke.Hive()
        const signatures = new FileSignatureStore(join(dataRoot, S.SignaturesFileName))
        await new ImageSigner(new DockerImageDigest(), signatures, new FileKeyStore(keysDir)).Sign(EffectiveRegistry.For(hive).ImageRef(S.Image), S.SigningKeyRef)
        const directory = new SeededTenantDirectory({ tenant: InClusterFederationSmoke.Tenant(), hives: [hive] })
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(dataRoot, S.RegistryFileName), docker)
        await registry.Load()
        const orchestrators = new HiveOrchestratorFactory(S.Context, dataRoot)
        const placement = new EnvironmentPlacement(directory)
        return new EnvironmentService(
            registry,
            new PortAllocator(S.EnvPortFloor, new NetPortProbe()),
            new EnvironmentRuntimeResolver(new DockerEnvironmentRuntime(docker, new BundleBuilderAdapter()), new InClusterEnvironmentRuntime(orchestrators, placement, directory, new BundleBuilderAdapter()), directory, orchestrators),
            new UserSeederAdapter(new UserSeeder()),
            dataRoot,
            new AdminProxy(new WsAdminConnector()),
            directory,
            new SmokeIdpService(connection),
            () => adminClient)
    }

    /** Real Chromium through the Ingress hosts: full login at env A, then env B on the IdP SSO cookie. */
    private async DriveBrowser(password: string): Promise<void>
    {
        const S = InClusterFederationSmoke
        const browser = await chromium.launch({ args: [S.HostResolverRules()] })
        try
        {
            const context = await browser.newContext({ ignoreHTTPSErrors: true })
            const pageA = await context.newPage()
            await pageA.goto(this.EnvOrigin(S.EnvAName) + S.BeginPath + encodeURIComponent(S.EnvAName))
            await pageA.waitForSelector(S.EmailSelector, { timeout: S.FormWaitMs })
            this.Expect(S.Labels.LoginForm, new URL(pageA.url()).host.startsWith(K8sManifestBuilder.IdpBrowserHostOf(S.TenantId, S.BaseDomain)))
            await pageA.fill(S.EmailSelector, S.OwnerEmail)
            await pageA.fill(S.PasswordSelector, password)
            await pageA.click(S.SubmitSelector)
            await pageA.waitForURL(url => url.pathname.includes(S.CallbackPathFragment), { timeout: S.CallbackWaitMs })
            await this.AssertSession(context, pageA, S.EnvAName, S.Labels.SessionA)

            const pageB = await context.newPage()
            await pageB.goto(this.EnvOrigin(S.EnvBName) + S.BeginPath + encodeURIComponent(S.EnvBName))
            await pageB.waitForURL(url => url.pathname.includes(S.CallbackPathFragment), { timeout: S.CallbackWaitMs })
            await pageB.waitForTimeout(S.SsoSettleMs)
            this.Expect(S.Labels.Sso, (await pageB.$(S.EmailSelector)) === null)
            await this.AssertSession(context, pageB, S.EnvBName, S.Labels.SessionB)
        }
        finally
        {
            await browser.close()
        }
    }

    /** The callback page body is JSON carrying the session token; /auth/session with that cookie must expose email + name. */
    private async AssertSession(context: BrowserContext, page: Page, envName: string, label: string): Promise<void>
    {
        const S = InClusterFederationSmoke
        const body = JSON.parse(await page.innerText(S.BodySelector)) as Record<string, unknown>
        const token = body[S.TokenKey]
        const cookie = S.SessionCookieName + S.CookieJoin + envName + S.TokenSep + String(token)
        const session = await context.request.get(this.EnvOrigin(envName) + S.SessionPath, { headers: { [S.CookieHeader]: cookie } })
        const info = (await session.json()) as Record<string, unknown>
        const ok = session.ok() && info[S.EmailKey] === S.OwnerEmail && typeof info[S.NameKey] === 'string' && info[S.NameKey] !== ''
        this.Expect(label, ok)
    }

    private EnvOrigin(envName: string): string
    {
        return InClusterFederationSmoke.ExternalScheme + InClusterFederationSmoke.SchemeSeparator + K8sManifestBuilder.EnvBrowserHostOf(envName, InClusterFederationSmoke.BaseDomain)
    }

    private StartForward(namespace: string, deployment: string, targetPort: number): ChildProcess
    {
        const S = InClusterFederationSmoke
        return spawn(S.Kubectl, [S.ContextFlag, S.Context, S.NamespaceFlag, namespace, S.PortForwardVerb, S.ServicePrefix + deployment, S.AutoLocalPort + String(targetPort)], { stdio: ['ignore', 'pipe', 'pipe'] })
    }

    private static LocalPortOf(child: ChildProcess): Promise<number>
    {
        const S = InClusterFederationSmoke
        return new Promise<number>((resolve, reject) =>
        {
            const timer = setTimeout(() => reject(new Error(S.ForwardTimeoutMessage)), S.ForwardTimeoutMs)
            child.stdout?.on(S.DataEvent, (chunk: Buffer) =>
            {
                const match = S.ForwardingPattern.exec(chunk.toString(S.Utf8))
                if (match !== null)
                {
                    clearTimeout(timer)
                    resolve(Number(match[1]))
                }
            })
            child.on(S.ErrorEvent, err =>
            {
                clearTimeout(timer)
                reject(err)
            })
        })
    }

    private StopForward(): void
    {
        this.forward?.kill(InClusterFederationSmoke.SigTerm)
        this.forward = undefined
    }

    private async Kubectl(args: string[]): Promise<void>
    {
        const S = InClusterFederationSmoke
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
        const S = InClusterFederationSmoke
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
        try
        {
            await action()
        }
        catch (err)
        {
            console.log(InClusterFederationSmoke.TeardownWarn + what + InClusterFederationSmoke.DetailSep + KubectlError.Redact(err instanceof Error ? err.message : String(err)))
        }
    }

    private Expect(label: string, ok: boolean, detail: string = ''): void
    {
        const S = InClusterFederationSmoke
        if (!ok)
        {
            this.failed = true
        }
        console.log((ok ? S.PassTag : S.FailTag) + label + (detail !== '' && !ok ? S.DetailSep + detail : ''))
    }

    private static Tenant(): TenantRecord
    {
        const S = InClusterFederationSmoke
        return { id: S.TenantId, clientId: S.TenantId, displayName: S.TenantId, createdAt: S.EpochIso }
    }

    private static Hive(): HiveRecord
    {
        const S = InClusterFederationSmoke
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

if (InClusterFederationSmoke.IsEntryPoint())
{
    await InClusterFederationSmoke.Main()
}
