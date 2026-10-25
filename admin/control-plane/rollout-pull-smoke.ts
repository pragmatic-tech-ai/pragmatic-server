/**
 * GATED real-cluster smoke for the SP-HIVE-4 rollout PULL path. NOT part of `tsx --test`.
 *
 * Requires Docker Desktop's built-in Kubernetes (context `docker-desktop`), docker, and a
 * `pragmatic-server:dev` image built AFTER the pull agent landed (it must contain
 * `dist/bin/pragmatic-agentd.js`; rebuild with the invocation in docker/Dockerfile's header). Run with:
 *
 *   npx tsx admin/control-plane/rollout-pull-smoke.ts
 *
 * Brings an environment up on v1, deploys the in-cluster agent (SA/Role/RoleBinding/Deployment + a token
 * Secret) pointed at a locally served ControlPlaneHost (via a Host-header-rewriting proxy reachable as
 * host.docker.internal), records v2 as the hive's target WITHOUT pushing (the second registry's backend
 * is unreachable, so SelectTarget only records), then asserts the AGENT patches the server Deployment to
 * v2 on its own and reports back so the environment is no longer obsolete.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HiveObservationRegistry } from './hive-observation-record.js'
import { fileURLToPath } from 'node:url'
import { ClientRegistry } from './client-registry.js'
import { ControlPlaneHost } from './control-plane-host.js'
import type { TenantProvisioningService } from './tenant-provisioning-service.js'
import type { IEnvironmentService, IGraphService } from './control-plane-host.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvStatus, EnvType, Template } from './environment-record.js'
import type { EnvironmentRecord, IContainerProbe } from './environment-record.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import { GatingRegistry } from './gating-record.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { UnsupportedBackendError } from './hive-orchestrator.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { HiveRegistry } from './hive-registry.js'
import { DockerImageDigest } from './image-digest.js'
import { ImageSigner } from './image-signer.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { FileKeyStore } from './key-store.js'
import { KubectlCli, KubectlError, NodeExecFile } from './kubectl.js'
import { ManifestRegistry } from './manifest-record.js'
import type { IOperatorIdentity, OperatorPrincipal, OperatorSession } from './operator-identity.js'
import { PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import { PlatformDirectory } from './platform-directory.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord } from './platform-records.js'
import { RolloutRegistrationRegistry } from './rollout-registration-record.js'
import { RolloutReportRegistry } from './rollout-report-record.js'
import { SelectionRegistry } from './selection-record.js'
import { FileSignatureStore } from './signature-store.js'
import { TenantRegistry } from './tenant-registry.js'

/** The smoke never reconciles against docker, so no container is ever reported running. */
class NoContainerProbe implements IContainerProbe
{
    public async Running(_containerName: string): Promise<boolean>
    {
        return false
    }
}

/** The agent routes need no operator session; this stand-in authenticates nobody. */
class DenyAllOperator implements IOperatorIdentity
{
    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        return null
    }

    public async ValidateToken(_token: string): Promise<OperatorPrincipal | null>
    {
        return null
    }

    public async Revoke(_token: string): Promise<void>
    {
    }
}

/** A factory whose backend is unreachable: SelectTarget records the selection, then the push is skipped (left for the pull agent). */
class UnreachableFactory extends HiveOrchestratorFactory
{
    public override For(hive: HiveRecord): IHiveOrchestrator
    {
        throw new UnsupportedBackendError(hive.cluster.backend, hive.cluster.mode)
    }
}

/**
 * ControlPlaneHost only accepts loopback Host headers (DNS-rebinding guard), but a pod reaches the workstation as
 * host.docker.internal. This proxy listens on all interfaces and forwards verbatim with the Host header rewritten
 * to loopback, so the REAL host's agent routes are what the pod talks to.
 */
class HostHeaderProxy
{
    private static readonly HostHeader = 'host'
    private static readonly ListenAddress = '0.0.0.0'
    private static readonly Loopback = '127.0.0.1'
    private static readonly BadGateway = 502
    private static readonly ErrorEvent = 'error'

    private server: Server | undefined

    public constructor(private readonly upstreamPort: number)
    {
    }

    public Listen(): Promise<number>
    {
        const S = HostHeaderProxy
        const server = createServer((req, res) => this.Forward(req, res))
        this.server = server
        return new Promise((resolve, reject) =>
        {
            server.once(S.ErrorEvent, reject)
            server.listen(0, S.ListenAddress, () =>
            {
                server.off(S.ErrorEvent, reject)
                resolve((server.address() as AddressInfo).port)
            })
        })
    }

    public async Close(): Promise<void>
    {
        const server = this.server
        this.server = undefined
        if (server !== undefined)
        {
            server.closeAllConnections()
            await new Promise<void>(res => server.close(() => res()))
        }
    }

    private Forward(req: IncomingMessage, res: ServerResponse): void
    {
        const S = HostHeaderProxy
        const headers = { ...req.headers, [S.HostHeader]: S.Loopback + ':' + this.upstreamPort }
        const upstream = request({ host: S.Loopback, port: this.upstreamPort, method: req.method, path: req.url, headers }, up =>
        {
            res.writeHead(up.statusCode ?? S.BadGateway, up.headers)
            up.pipe(res)
        })
        upstream.on(S.ErrorEvent, () =>
        {
            res.writeHead(S.BadGateway)
            res.end()
        })
        req.pipe(upstream)
    }
}

export class RolloutPullSmoke
{
    private static readonly Context = 'docker-desktop'
    private static readonly EnvPrefix = 'pull-smoke-'
    private static readonly SuffixBytes = 3
    private static readonly Hex = 'hex'
    private static readonly ClientId = 'pull-client'
    private static readonly TenantId = 'pull-tenant'
    private static readonly HiveId = 'pull-hive'
    private static readonly BaseImage = 'pragmatic-server:dev'
    private static readonly ImageV1 = 'pragmatic-server:v1'
    private static readonly ImageV2 = 'pragmatic-server:v2'
    private static readonly VersionV1 = 'v1'
    private static readonly VersionV2 = 'v2'
    private static readonly Docker = 'docker'
    private static readonly TagVerb = 'tag'
    private static readonly ImageVerb = 'rmi'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly NamespaceFlag = '-n'
    private static readonly GetVerb = 'get'
    private static readonly LogsVerb = 'logs'
    private static readonly PodKind = 'pod'
    private static readonly NamespaceKind = 'namespace'
    private static readonly DeploymentPrefix = 'deploy/'
    private static readonly TailFlag = '--tail=40'
    private static readonly NotFoundWord = 'NotFound'
    private static readonly KeysDirName = 'keys'
    private static readonly SignaturesFileName = 'signatures.json'
    private static readonly ManifestsFileName = 'manifests.json'
    private static readonly GatingFileName = 'gating.json'
    private static readonly SelectionsFileName = 'selections.json'
    private static readonly ReportsFileName = 'reports.json'
    private static readonly RegistrationsFileName = 'registrations.json'
    private static readonly ClientsFileName = 'clients.json'
    private static readonly TenantsFileName = 'tenants.json'
    private static readonly HivesFileName = 'hives.json'
    private static readonly EnvironmentsFileName = 'environments.json'
    private static readonly DataRootDirName = 'data'
    private static readonly StaticDirName = 'static'
    private static readonly TempDirPrefix = 'pull-smoke-'
    private static readonly SigningKeyRef = 'dev-signing'
    private static readonly Ed25519 = 'ed25519'
    private static readonly Pem = 'pem'
    private static readonly Spki = 'spki'
    private static readonly Pkcs8 = 'pkcs8'
    private static readonly Utf8 = 'utf8'
    private static readonly EpochIso = '1970-01-01T00:00:00.000Z'
    private static readonly EmptyString = ''
    private static readonly DisplayName = 'pull smoke'
    private static readonly BootBaseDirKey = 'PRAGMATIC_BASE_DIR'
    private static readonly BootBaseDir = '/tmp/pragmatic-data'
    private static readonly BootTenantKey = 'PRAGMATIC_ENVIRONMENT_ID'
    private static readonly BootMasterKeyEnvKey = 'PRAGMATIC_MASTER_KEY_B64_ENV'
    private static readonly BootMasterKeyVar = 'SMOKE_MASTER_KEY_B64'
    private static readonly MasterKeyBytes = 32
    private static readonly Base64 = 'base64'
    private static readonly LoopbackAddress = '127.0.0.1'
    private static readonly ClusterHostUrl = 'http://host.docker.internal:'
    private static readonly ProxyLabel = 'proxy'
    private static readonly HostLabel = 'control plane host'
    private static readonly TokenSecretSuffix = '-agent-token'
    private static readonly SecretKey = 'token'
    private static readonly SecretKind = 'Secret'
    private static readonly SecretApiVersion = 'v1'
    private static readonly SecretOpaque = 'Opaque'
    private static readonly SecretStringData = 'stringData'
    private static readonly SecretType = 'type'
    private static readonly MetaKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly PollTimeoutMs = 240000
    private static readonly PollIntervalMs = 3000
    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly InfoTag = 'INFO '
    private static readonly TeardownWarning = 'WARN best-effort teardown failed for '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly InfoSigned = 'signed both image refs with key ref: '
    private static readonly InfoPublished = 'published + gated versions: '
    private static readonly InfoRunning = 'server image: '
    private static readonly InfoServing = 'control plane host + proxy listening; pod-visible registry url: '
    private static readonly InfoRegistered = 'hive registered; machine token stored in the namespace Secret (not logged)'
    private static readonly InfoAgentApplied = 'agent objects applied'
    private static readonly InfoSelected = 'target v2 recorded without push'
    private static readonly InfoStatus = 'rollout status: '
    private static readonly InfoAgentLogs = 'agent logs (tail):\n'
    private static readonly InfoAgentPod = 'pods:\n'
    private static readonly VersionSep = ', '
    private static readonly Labels = {
        UpOnV1: 'k8s: environment up on v1 (Ready, running pragmatic-server:v1)',
        SelectNoPush: 'registry: SelectTarget(v2) only records; the env still runs v1',
        AgentPatched: 'pull: the in-cluster agent patched the server Deployment to pragmatic-server:v2 on its own',
        Reported: 'pull: the agent reported back so the env is no longer obsolete',
        TargetV2: 'registry: TargetFor(hive) is v2',
    }

    private failed = false
    private tempDir: string | undefined
    private tagged = false
    private host: ControlPlaneHost | undefined
    private proxy: HostHeaderProxy | undefined
    private applied = false
    private readonly exec = new NodeExecFile()
    private readonly envName = RolloutPullSmoke.EnvPrefix + randomBytes(RolloutPullSmoke.SuffixBytes).toString(RolloutPullSmoke.Hex)

    public static async Main(): Promise<void>
    {
        const smoke = new RolloutPullSmoke()
        const ok = await smoke.Run()
        console.log(ok ? RolloutPullSmoke.OverallPass : RolloutPullSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = RolloutPullSmoke
        try
        {
            this.tempDir = await mkdtemp(join(tmpdir(), S.TempDirPrefix))
            await this.TagImages()
            const dataRoot = join(this.tempDir, S.DataRootDirName)
            await this.SignBoth(dataRoot)

            const environments = new EnvironmentRegistry(this.TempFile(S.EnvironmentsFileName), new NoContainerProbe())
            const directory = new PlatformDirectory(
                new ClientRegistry(this.TempFile(S.ClientsFileName)),
                new TenantRegistry(this.TempFile(S.TenantsFileName)),
                new HiveRegistry(this.TempFile(S.HivesFileName)),
                environments)
            await directory.Load()
            await directory.CreateClient({ id: S.ClientId, displayName: S.DisplayName })
            await directory.CreateTenant({ id: S.TenantId, clientId: S.ClientId, displayName: S.DisplayName })
            const hive = await directory.CreateHive({
                id: S.HiveId,
                tenantId: S.TenantId,
                displayName: S.DisplayName,
                cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: S.Context },
                registry: { mode: InfraMode.Attach },
                trustRootRef: S.SigningKeyRef,
            })

            const factory = new HiveOrchestratorFactory(S.Context, dataRoot)
            const stores = await this.LoadStores()
            const placement = new EnvironmentPlacement(directory)
            // Same stores, two registries: `registry` is served to the agent; `recorder` cannot reach the cluster, so SelectTarget only records.
            const registry = new PlatformDeploymentRegistry(stores.manifests, stores.gating, stores.selections, stores.reports, stores.registrations, directory, factory, environments, placement)
            const recorder = new PlatformDeploymentRegistry(stores.manifests, stores.gating, stores.selections, stores.reports, stores.registrations, directory, new UnreachableFactory(S.Context, dataRoot), environments, placement)
            await registry.Publish(S.VersionV1, S.ImageV1)
            await registry.Publish(S.VersionV2, S.ImageV2)
            await registry.Gate(S.TenantId, S.VersionV1)
            await registry.Gate(S.TenantId, S.VersionV2)
            console.log(S.InfoTag + S.InfoPublished + S.VersionV1 + S.VersionSep + S.VersionV2)

            const registryUrl = await this.Serve(directory, factory, registry)
            const machineToken = await registry.RegisterHive(S.HiveId)

            const record = this.NewRecord()
            await environments.Put(record)
            const workload = this.BootWorkload(placement.WorkloadFor(record))
            const orchestrator = factory.For(hive)
            await orchestrator.Apply({ ...workload, image: S.ImageV1 })
            await orchestrator.WaitHealthy(workload)
            await this.CheckRunning(orchestrator, workload, S.ImageV1, S.Labels.UpOnV1)

            await this.ApplyAgent(workload, registryUrl, machineToken)

            await recorder.SelectTarget(S.HiveId, S.VersionV2)
            console.log(S.InfoTag + S.InfoSelected)
            this.Expect(S.Labels.TargetV2, registry.TargetFor(S.HiveId)?.version === S.VersionV2)
            const immediate = await orchestrator.Health(workload)
            this.Expect(S.Labels.SelectNoPush, immediate.runningImage === S.ImageV1, immediate.detail)

            await this.AwaitAgentPatch(orchestrator, workload)
            await this.AwaitReport(registry)
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + KubectlError.Redact(err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            await this.Diagnose()
            await this.Cleanup()
        }
        return !this.failed
    }

    private TempFile(name: string): string
    {
        return join(this.tempDir!, name)
    }

    private async LoadStores(): Promise<{ manifests: ManifestRegistry; gating: GatingRegistry; selections: SelectionRegistry; reports: RolloutReportRegistry; registrations: RolloutRegistrationRegistry }>
    {
        const S = RolloutPullSmoke
        const manifests = new ManifestRegistry(this.TempFile(S.ManifestsFileName))
        const gating = new GatingRegistry(this.TempFile(S.GatingFileName))
        const selections = new SelectionRegistry(this.TempFile(S.SelectionsFileName))
        const reports = new RolloutReportRegistry(this.TempFile(S.ReportsFileName))
        const registrations = new RolloutRegistrationRegistry(this.TempFile(S.RegistrationsFileName))
        for (const store of [manifests, gating, selections, reports, registrations])
        {
            await store.Load()
        }
        return { manifests, gating, selections, reports, registrations }
    }

    /** Serves the real ControlPlaneHost on loopback behind the Host-rewriting proxy; returns the URL a pod uses. */
    private async Serve(directory: PlatformDirectory, factory: HiveOrchestratorFactory, deployments: PlatformDeploymentRegistry): Promise<string>
    {
        const S = RolloutPullSmoke
        const staticRoot = join(this.tempDir!, S.StaticDirName)
        await mkdir(staticRoot, { recursive: true })
        const host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, staticRoot, new DenyAllOperator(), false, directory, factory, deployments, {} as TenantProvisioningService, new HiveObservationRegistry(join(tmpdir(), 'unused-observations.json')))
        await host.Listen(0, S.LoopbackAddress)
        this.host = host
        const proxy = new HostHeaderProxy(host.Address().port)
        this.proxy = proxy
        const url = S.ClusterHostUrl + await proxy.Listen()
        console.log(S.InfoTag + S.InfoServing + url)
        return url
    }

    /** Creates the token Secret (key `token`) and applies the agent objects. The token travels only over kubectl's stdin. */
    private async ApplyAgent(workload: EnvironmentWorkload, registryUrl: string, machineToken: string): Promise<void>
    {
        const S = RolloutPullSmoke
        const kubectl = new KubectlCli(S.Context)
        const secretName = this.envName + S.TokenSecretSuffix
        this.applied = true
        await kubectl.Apply(JSON.stringify({
            [S.ApiVersionKey]: S.SecretApiVersion,
            [S.KindKey]: S.SecretKind,
            [S.MetaKey]: { [S.NameKey]: secretName, [S.NamespaceKey]: K8sManifestBuilder.NamespaceOf(this.envName) },
            [S.SecretType]: S.SecretOpaque,
            [S.SecretStringData]: { [S.SecretKey]: machineToken },
        }))
        console.log(S.InfoTag + S.InfoRegistered)
        await kubectl.Apply(new K8sManifestBuilder().RenderAgent(workload, registryUrl, secretName))
        console.log(S.InfoTag + S.InfoAgentApplied)
    }

    private async AwaitAgentPatch(orchestrator: IHiveOrchestrator, workload: EnvironmentWorkload): Promise<void>
    {
        const S = RolloutPullSmoke
        const deadline = Date.now() + S.PollTimeoutMs
        let detail = S.EmptyString
        let image: string | undefined
        while (Date.now() < deadline)
        {
            const health = await orchestrator.Health(workload)
            image = health.runningImage
            detail = health.detail
            if (image === S.ImageV2)
            {
                break
            }
            await RolloutPullSmoke.Sleep(S.PollIntervalMs)
        }
        console.log(S.InfoTag + S.InfoRunning + image)
        this.Expect(S.Labels.AgentPatched, image === S.ImageV2, detail)
    }

    private async AwaitReport(registry: PlatformDeploymentRegistry): Promise<void>
    {
        const S = RolloutPullSmoke
        const deadline = Date.now() + S.PollTimeoutMs
        let ok = false
        let text = S.EmptyString
        while (Date.now() < deadline)
        {
            const status = registry.StatusFor(S.HiveId)
            text = JSON.stringify(status)
            const env = status.environments.find(e => e.environmentName === this.envName)
            if (env !== undefined && !env.obsolete && env.runningImage === S.ImageV2)
            {
                ok = true
                break
            }
            await RolloutPullSmoke.Sleep(S.PollIntervalMs)
        }
        console.log(S.InfoTag + S.InfoStatus + text)
        this.Expect(S.Labels.Reported, ok, text)
    }

    private static Sleep(ms: number): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /** Two refs of the same underlying image: the roll is observable through the ref the Deployment runs. */
    private async TagImages(): Promise<void>
    {
        const S = RolloutPullSmoke
        this.tagged = true
        await this.exec.Run(S.Docker, [S.TagVerb, S.BaseImage, S.ImageV1])
        await this.exec.Run(S.Docker, [S.TagVerb, S.BaseImage, S.ImageV2])
    }

    /** Signs both bare refs (the hive has no registry endpoint, so the effective ref is unchanged) into the factory dataRoot stores. */
    private async SignBoth(dataRoot: string): Promise<void>
    {
        const S = RolloutPullSmoke
        const keysDir = join(dataRoot, S.KeysDirName)
        await this.WriteKeyPair(keysDir, S.SigningKeyRef)
        const signer = new ImageSigner(new DockerImageDigest(), new FileSignatureStore(join(dataRoot, S.SignaturesFileName)), new FileKeyStore(keysDir))
        await signer.Sign(S.ImageV1, S.SigningKeyRef)
        await signer.Sign(S.ImageV2, S.SigningKeyRef)
        console.log(S.InfoTag + S.InfoSigned + S.SigningKeyRef)
    }

    private async CheckRunning(orchestrator: IHiveOrchestrator, workload: EnvironmentWorkload, expected: string, label: string): Promise<void>
    {
        const health = await orchestrator.Health(workload)
        console.log(RolloutPullSmoke.InfoTag + RolloutPullSmoke.InfoRunning + health.runningImage)
        this.Expect(label, health.ready && health.runningImage === expected, health.detail)
    }

    /** Writes `<ref>.pub` / `<ref>.key` PEM files in the layout FileKeyStore reads. The private PEM is never logged. */
    private async WriteKeyPair(keysDir: string, ref: string): Promise<void>
    {
        const S = RolloutPullSmoke
        await mkdir(keysDir, { recursive: true })
        const pair = generateKeyPairSync(S.Ed25519)
        await writeFile(join(keysDir, ref + FileKeyStore.PublicSuffix), pair.publicKey.export({ type: S.Spki, format: S.Pem }), S.Utf8)
        await writeFile(join(keysDir, ref + FileKeyStore.PrivateSuffix), pair.privateKey.export({ type: S.Pkcs8, format: S.Pem }), S.Utf8)
    }

    /** A throwaway dev-blank environment bound to the smoke hive, owned by the hive tenant. */
    private NewRecord(): EnvironmentRecord
    {
        const S = RolloutPullSmoke
        return {
            name: this.envName,
            type: EnvType.Development,
            template: Template.DevBlank,
            environmentId: S.TenantId,
            hiveId: S.HiveId,
            hostPort: 0,
            containerName: this.envName,
            volumeName: this.envName,
            bundleDir: S.EmptyString,
            createdAt: S.EpochIso,
            status: EnvStatus.Unknown,
        }
    }

    /** LOCAL-SMOKE-ONLY boot config (same approach as k8s-hive-smoke): throwaway random key, never logged or written to disk. */
    private BootWorkload(stock: EnvironmentWorkload): EnvironmentWorkload
    {
        const S = RolloutPullSmoke
        const boot = {
            [S.BootBaseDirKey]: S.BootBaseDir,
            [S.BootTenantKey]: this.envName,
            [S.BootMasterKeyEnvKey]: S.BootMasterKeyVar,
            [S.BootMasterKeyVar]: randomBytes(S.MasterKeyBytes).toString(S.Base64),
        }
        return { ...stock, env: { ...stock.env, ...boot } }
    }

    private async NamespaceExists(namespace: string): Promise<boolean>
    {
        const S = RolloutPullSmoke
        try
        {
            await this.exec.Run(S.Kubectl, [S.ContextFlag, S.Context, S.GetVerb, S.NamespaceKind, namespace])
            return true
        }
        catch (e)
        {
            const stderr = String((e as { stderr?: unknown }).stderr ?? S.EmptyString)
            if (stderr.includes(S.NotFoundWord))
            {
                return false
            }
            throw e
        }
    }

    /** Prints the pod list + agent log tail (redacted) so a failed pull is diagnosable; the agent never logs its token. */
    private async Diagnose(): Promise<void>
    {
        const S = RolloutPullSmoke
        if (!this.applied)
        {
            return
        }
        const namespace = K8sManifestBuilder.NamespaceOf(this.envName)
        const agent = K8sManifestBuilder.AgentDeploymentOf(this.envName)
        await this.BestEffort(agent, async () =>
        {
            const pods = await this.exec.Run(S.Kubectl, [S.ContextFlag, S.Context, S.GetVerb, S.PodKind, S.NamespaceFlag, namespace])
            console.log(S.InfoTag + S.InfoAgentPod + KubectlError.Redact(pods.stdout))
            const logs = await this.exec.Run(S.Kubectl, [S.ContextFlag, S.Context, S.LogsVerb, S.DeploymentPrefix + agent, S.NamespaceFlag, namespace, S.TailFlag])
            console.log(S.InfoTag + S.InfoAgentLogs + KubectlError.Redact(logs.stdout + logs.stderr))
        })
    }

    /** Always-run cleanup: namespace, local server + proxy, the two extra image tags, temp stores. */
    private async Cleanup(): Promise<void>
    {
        const S = RolloutPullSmoke
        const namespace = K8sManifestBuilder.NamespaceOf(this.envName)
        await this.BestEffort(namespace, async () =>
        {
            if (await this.NamespaceExists(namespace))
            {
                await new KubectlCli(S.Context).DeleteNamespace(namespace)
            }
        })
        await this.BestEffort(S.ProxyLabel, async () => { await this.proxy?.Close() })
        await this.BestEffort(S.HostLabel, async () => { await this.host?.Close() })
        if (this.tagged)
        {
            await this.BestEffort(S.ImageV1, async () => { await this.exec.Run(S.Docker, [S.ImageVerb, S.ImageV1]) })
            await this.BestEffort(S.ImageV2, async () => { await this.exec.Run(S.Docker, [S.ImageVerb, S.ImageV2]) })
        }
        if (this.tempDir !== undefined)
        {
            const dir = this.tempDir
            await this.BestEffort(dir, () => rm(dir, { recursive: true, force: true }))
        }
    }

    private async BestEffort(what: string, action: () => Promise<unknown>): Promise<void>
    {
        const S = RolloutPullSmoke
        try
        {
            await action()
        }
        catch (e)
        {
            console.log(S.TeardownWarning + what + S.DetailSep + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
    }

    private Expect(label: string, ok: boolean, detail: string = RolloutPullSmoke.EmptyString): void
    {
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === RolloutPullSmoke.EmptyString ? RolloutPullSmoke.EmptyString : RolloutPullSmoke.DetailSep + KubectlError.Redact(detail)
        console.log((ok ? RolloutPullSmoke.PassTag : RolloutPullSmoke.FailTag) + label + suffix)
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (RolloutPullSmoke.IsEntryPoint())
{
    await RolloutPullSmoke.Main()
}
