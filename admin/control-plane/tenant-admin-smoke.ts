/**
 * GATED real-cluster smoke for the extracted tenant-admin container. NOT part of `tsx --test`.
 *
 * Requires a local Kubernetes context (default `docker-desktop`; override with PRAGMATIC_SMOKE_CONTEXT) and a
 * `pragmatic-server:dev` image built AFTER the tenant-admin packaging landed (it must contain
 * `dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js` and `dist-tenant-admin/admin/tenant-portal/dist`; rebuild with
 * the invocation in docker/Dockerfile's header, and on a kind cluster `kind load docker-image pragmatic-server:dev`).
 * Run with:
 *
 *   npx tsx admin/control-plane/tenant-admin-smoke.ts
 *
 * Plays the platform: composes a directory + deployment registry in-process, publishes and gates two versions, serves the
 * REAL AgentChannelHost on all interfaces (pod-visible as host.docker.internal; override the host with
 * PRAGMATIC_SMOKE_CHANNEL_HOST), then generates a bootstrap with TenantAdminBootstrap (agent token, per-tenant master key,
 * seed read-models, trust-root public key) and applies it: the per-hive agent objects plus the tenant-admin container
 * (RenderTenantAdmin), then the bootstrap Secrets. The seed Secret also carries a DIRECTLY-SEEDED tenant session and one
 * environment record (no browser OIDC login is performed). The smoke then asserts the container SERVES (rollout ready,
 * GET / serves the SPA, unauthenticated /tenant-auth/session and /tenant-api/* answer 401) and, with the seeded session
 * cookie through a kubectl port-forward, that /tenant-api lists the hive and the seeded environment, reads the gated
 * manifests over the agent channel, and adopts a version, which the platform registry then records as the hive target.
 *
 * Environment creation is NOT exercised: the tenant plane exposes no create route, and in-pod lifecycle needs a
 * non-docker environment driver that does not exist yet (see the task report).
 */
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentChannelHost } from './agent-channel-host.js'
import { ClientRegistry } from './client-registry.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvStatus, EnvType, Template } from './environment-record.js'
import type { EnvironmentRecord, IContainerProbe } from './environment-record.js'
import { GatingRegistry } from './gating-record.js'
import { HiveObservationRegistry } from './hive-observation-record.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { HiveRegistry } from './hive-registry.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KubectlCli, KubectlError, NodeExecFile } from './kubectl.js'
import { ManifestRegistry } from './manifest-record.js'
import { PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import { PlatformDirectory } from './platform-directory.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import { RolloutRegistrationRegistry } from './rollout-registration-record.js'
import { SelectionRegistry } from './selection-record.js'
import { ControlPlaneServer } from './server.js'
import { TenantAdminBootstrap } from './tenant-admin-bootstrap.js'
import type { TenantBootstrap } from './tenant-admin-bootstrap.js'
import { TenantRegistry } from './tenant-registry.js'
import { TenantSessionCookie } from './tenant-auth/tenant-session-cookie.js'

/** The smoke never reconciles against docker, so no container is ever reported running. */
class NoContainerProbe implements IContainerProbe
{
    public async Running(_containerName: string): Promise<boolean>
    {
        return false
    }
}

/** The slices of the tenant-api responses the smoke reads. */
type SessionDto = { principalId?: string }
type HiveDto = { id?: string }
type EnvironmentDto = { name?: string }
type ManifestDto = { id?: string }

type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: unknown }

export class TenantAdminSmoke
{
    private static readonly ContextEnv = 'PRAGMATIC_SMOKE_CONTEXT'
    private static readonly ImageEnv = 'PRAGMATIC_SMOKE_IMAGE'
    private static readonly ChannelHostEnv = 'PRAGMATIC_SMOKE_CHANNEL_HOST'
    private static readonly DefaultContext = 'docker-desktop'
    private static readonly DefaultImage = 'pragmatic-server:dev'
    private static readonly DefaultChannelHost = 'host.docker.internal'
    private static readonly ClientId = 'ta-client'
    private static readonly TenantId = 'ta-tenant'
    private static readonly HiveId = 'ta-hive'
    private static readonly DisplayName = 'tenant admin smoke'
    private static readonly VersionV1 = 'v1'
    private static readonly VersionV2 = 'v2'
    private static readonly ImageV1 = 'pragmatic-server:v1'
    private static readonly ImageV2 = 'pragmatic-server:v2'
    private static readonly SigningKeyRef = 'dev-signing'
    private static readonly TenantPlanePort = 8443
    private static readonly BaseDomain = 'tenants.smoke.test'
    private static readonly Scheme = 'http'
    private static readonly SeedEnvName = 'ta-seeded-env'
    private static readonly SessionsFile = 'tenant-sessions.json'
    private static readonly SessionsRootKey = 'sessions'
    private static readonly SessionPrincipal = 'smoke-maker'
    private static readonly SessionEmail = 'maker@ta-smoke.test'
    private static readonly SessionTtlMs = 3600000
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'
    private static readonly Ed25519 = 'ed25519'
    private static readonly Pem = 'pem'
    private static readonly Spki = 'spki'
    private static readonly Utf8 = 'utf8'
    private static readonly ContentTypeResponseHeader = 'content-type'
    private static readonly ChannelLabel = 'agent channel host'
    private static readonly HiveSelectorPrefix = 'pragmatic/hive='
    private static readonly DotSep = '.'
    private static readonly Space = ' '
    private static readonly NameJoin = ', '
    private static readonly EnvironmentsKey = 'environments'
    private static readonly EpochIso = '1970-01-01T00:00:00.000Z'
    private static readonly EmptyString = ''
    private static readonly DataRootDirName = 'data'
    private static readonly TempDirPrefix = 'ta-smoke-'
    private static readonly ClientsFileName = 'clients.json'
    private static readonly TenantsFileName = 'tenants.json'
    private static readonly HivesFileName = 'hives.json'
    private static readonly EnvironmentsFileName = 'environments.json'
    private static readonly ManifestsFileName = 'manifests.json'
    private static readonly GatingFileName = 'gating.json'
    private static readonly SelectionsFileName = 'selections.json'
    private static readonly ObservationsFileName = 'hive-observations.json'
    private static readonly RegistrationsFileName = 'registrations.json'
    private static readonly ListenAddress = '0.0.0.0'
    private static readonly LoopbackHost = '127.0.0.1'
    private static readonly HttpPrefix = 'http://'
    private static readonly UrlPortSep = ':'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly NamespaceFlag = '-n'
    private static readonly SelectorFlag = '-l'
    private static readonly GetVerb = 'get'
    private static readonly DeleteVerb = 'delete'
    private static readonly LogsVerb = 'logs'
    private static readonly PortForwardVerb = 'port-forward'
    private static readonly ContainerFlag = '-c'
    private static readonly TailFlag = '--tail=60'
    private static readonly IgnoreNotFoundFlag = '--ignore-not-found'
    private static readonly PodKind = 'pod'
    private static readonly NamespaceKind = 'namespace'
    private static readonly SecretKind = 'secret'
    private static readonly DeploymentPrefix = 'deploy/'
    private static readonly ServicePrefix = 'svc/'
    private static readonly NamespacedKinds = 'deployment,service,serviceaccount,persistentvolumeclaim'
    private static readonly ClusterKinds = 'clusterrole,clusterrolebinding'
    private static readonly ForwardingReady = 'Forwarding from'
    private static readonly NotFoundWord = 'NotFound'
    private static readonly SeedContainer = 'seed'
    private static readonly TenantAdminContainer = 'tenant-admin'
    private static readonly HostHeader = 'Host'
    private static readonly OriginHeader = 'Origin'
    private static readonly CookieHeader = 'Cookie'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonContentType = 'application/json'
    private static readonly HtmlWord = 'text/html'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly RootPath = '/'
    private static readonly SessionPath = '/tenant-auth/session'
    private static readonly HivesPath = '/tenant-api/hives'
    private static readonly EnvironmentsPath = '/tenant-api/environments'
    private static readonly ManifestsPath = '/tenant-api/manifests'
    private static readonly HivesPrefix = '/tenant-api/hives/'
    private static readonly TargetSuffix = '/target'
    private static readonly VersionKey = 'version'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly StatusOk = 200
    private static readonly StatusNoContent = 204
    private static readonly StatusUnauthorized = 401
    private static readonly ForwardTimeoutMs = 30000
    private static readonly PollTimeoutMs = 120000
    private static readonly PollIntervalMs = 3000
    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly InfoTag = 'INFO '
    private static readonly DetailSep = ' -- '
    private static readonly StatusWord = ' status='
    private static readonly TeardownWarning = 'WARN best-effort teardown failed for '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly ForwardTimeoutMessage = 'kubectl port-forward did not become ready'
    private static readonly InfoServing = 'agent channel host listening; pod-visible base url: '
    private static readonly InfoBootstrap = 'bootstrap generated; secrets (not logged): '
    private static readonly InfoApplied = 'bootstrap manifest + secrets applied'
    private static readonly InfoPods = 'pods:\n'
    private static readonly InfoSeedLogs = 'seed init container logs (tail):\n'
    private static readonly InfoAdminLogs = 'tenant-admin logs (tail):\n'
    private static readonly Labels = {
        Rollout: 'k8s: the tenant-admin Deployment rolls out ready (init seed + readiness on the SPA root)',
        SpaServed: 'serves: GET / returns 200 html (the tenant-portal SPA)',
        SessionGate: 'serves: /tenant-auth/session without a cookie returns 401',
        ApiGate: 'serves: /tenant-api/hives without a cookie returns 401',
        Session: 'seeded session: /tenant-auth/session returns 200 for the seeded principal',
        Hives: 'tenant-api: /hives lists exactly the seeded hive',
        Environments: 'tenant-api: /environments lists the seeded environment',
        Manifests: 'tenant-api: /manifests returns both gated versions through the agent channel',
        Adopt: 'tenant-api: POST /hives/:id/target adopts v2 (204)',
        Recorded: 'platform: the registry now records v2 as the hive target',
    }

    private failed = false
    private tempDir: string | undefined
    private channel: AgentChannelHost | undefined
    private forward: ChildProcess | undefined
    private applied = false
    private systemNamespacePreExisted = true
    private bootstrap: TenantBootstrap | undefined
    private readonly exec = new NodeExecFile()
    private readonly context = process.env[TenantAdminSmoke.ContextEnv] ?? TenantAdminSmoke.DefaultContext
    private readonly image = process.env[TenantAdminSmoke.ImageEnv] ?? TenantAdminSmoke.DefaultImage
    private readonly channelHost = process.env[TenantAdminSmoke.ChannelHostEnv] ?? TenantAdminSmoke.DefaultChannelHost
    private readonly tenantHost = TenantAdminSmoke.TenantId + '.' + TenantAdminSmoke.BaseDomain
    private sessionToken = TenantAdminSmoke.EmptyString

    public static async Main(): Promise<void>
    {
        const smoke = new TenantAdminSmoke()
        const ok = await smoke.Run()
        console.log(ok ? TenantAdminSmoke.OverallPass : TenantAdminSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = TenantAdminSmoke
        try
        {
            this.tempDir = await mkdtemp(join(tmpdir(), S.TempDirPrefix))
            const environments = new EnvironmentRegistry(this.TempFile(S.EnvironmentsFileName), new NoContainerProbe())
            const directory = new PlatformDirectory(
                new ClientRegistry(this.TempFile(S.ClientsFileName)),
                new TenantRegistry(this.TempFile(S.TenantsFileName)),
                new HiveRegistry(this.TempFile(S.HivesFileName)),
                environments)
            await directory.Load()
            await directory.CreateClient({ id: S.ClientId, displayName: S.DisplayName })
            const tenant = await directory.CreateTenant({ id: S.TenantId, clientId: S.ClientId, displayName: S.DisplayName })
            const hive = await directory.CreateHive({
                id: S.HiveId,
                tenantId: S.TenantId,
                displayName: S.DisplayName,
                cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: this.context },
                registry: { mode: InfraMode.Attach },
                trustRootRef: S.SigningKeyRef,
            })

            const registry = await this.ComposeRegistry(directory, environments)
            await registry.Publish(S.VersionV1, S.ImageV1)
            await registry.Publish(S.VersionV2, S.ImageV2)
            await registry.Gate(S.TenantId, S.VersionV1)
            await registry.Gate(S.TenantId, S.VersionV2)
            const channelUrl = await this.ServeChannel(registry)

            this.bootstrap = await new TenantAdminBootstrap(registry).GenerateBootstrap({
                tenant,
                hive,
                tenantAdminImage: this.image,
                tenantPlanePort: S.TenantPlanePort,
                baseDomain: S.BaseDomain,
                externalScheme: S.Scheme,
                channelUrl,
                trustRootPublicKey: generateKeyPairSync(S.Ed25519).publicKey.export({ type: S.Spki, format: S.Pem }).toString(),
            })
            this.SeedTestState(this.bootstrap)
            console.log(S.InfoTag + S.InfoBootstrap + this.bootstrap.secrets.Names().join(S.NameJoin))

            await this.ApplyBootstrap(this.bootstrap)
            const admin = K8sManifestBuilder.TenantAdminNameOf(S.TenantId)
            let rolledOut = false
            try
            {
                await new KubectlCli(this.context).RolloutStatus(K8sManifestBuilder.SystemNamespace, admin)
                rolledOut = true
            }
            catch (e)
            {
                this.Expect(S.Labels.Rollout, false, e instanceof Error ? e.message : String(e))
            }
            if (rolledOut)
            {
                this.Expect(S.Labels.Rollout, true)
                const port = await this.StartForward(admin)
                await this.CheckUnauthenticated(port)
                await this.CheckAuthenticated(port)
                this.Expect(S.Labels.Recorded, registry.TargetFor(S.HiveId)?.version === S.VersionV2)
            }
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

    private async ComposeRegistry(directory: PlatformDirectory, environments: EnvironmentRegistry): Promise<PlatformDeploymentRegistry>
    {
        const S = TenantAdminSmoke
        const manifests = new ManifestRegistry(this.TempFile(S.ManifestsFileName))
        const gating = new GatingRegistry(this.TempFile(S.GatingFileName))
        const selections = new SelectionRegistry(this.TempFile(S.SelectionsFileName))
        const registrations = new RolloutRegistrationRegistry(this.TempFile(S.RegistrationsFileName))
        const observations = new HiveObservationRegistry(this.TempFile(S.ObservationsFileName))
        for (const store of [manifests, gating, selections, observations, registrations])
        {
            await store.Load()
        }
        const factory = new HiveOrchestratorFactory(this.context, join(this.tempDir!, S.DataRootDirName))
        return new PlatformDeploymentRegistry(manifests, gating, selections, registrations, directory, factory, environments, new EnvironmentPlacement(directory), observations)
    }

    /** Serves the real AgentChannelHost on all interfaces (no Host guard); returns the base URL a pod uses. */
    private async ServeChannel(deployments: PlatformDeploymentRegistry): Promise<string>
    {
        const S = TenantAdminSmoke
        const channel = new AgentChannelHost(deployments)
        await channel.Listen(0, S.ListenAddress)
        this.channel = channel
        const url = S.HttpPrefix + this.channelHost + S.UrlPortSep + channel.Address().port
        console.log(S.InfoTag + S.InfoServing + url)
        return url
    }

    /**
     * SMOKE-ONLY seeding that rides in the seed Secret next to seed.json: one pre-issued tenant session (so no browser OIDC
     * login is needed; the token never leaves this process and the cluster Secret) and one environment record to list.
     */
    private SeedTestState(bootstrap: TenantBootstrap): void
    {
        const S = TenantAdminSmoke
        this.sessionToken = randomBytes(S.TokenBytes).toString(S.TokenEncoding)
        const session = {
            id: this.sessionToken,
            tenantId: S.TenantId,
            principalId: S.SessionPrincipal,
            email: S.SessionEmail,
            expiresAt: new Date(Date.now() + S.SessionTtlMs).toISOString(),
        }
        const record: EnvironmentRecord = {
            name: S.SeedEnvName,
            type: EnvType.Development,
            template: Template.DevBlank,
            environmentId: S.TenantId,
            tenantId: S.TenantId,
            hiveId: S.HiveId,
            hostPort: 0,
            containerName: S.SeedEnvName,
            volumeName: S.SeedEnvName,
            bundleDir: S.EmptyString,
            createdAt: S.EpochIso,
            status: EnvStatus.Unknown,
        }
        bootstrap.secrets.AddEntry(bootstrap.seedSecretName, S.SessionsFile, JSON.stringify({ [S.SessionsRootKey]: { [session.id]: session } }))
        bootstrap.secrets.AddEntry(bootstrap.seedSecretName, ControlPlaneServer.RegistryFile, JSON.stringify({ [S.EnvironmentsKey]: { [record.name]: record } }))
    }

    /** Manifest first (creates the shared Namespace), then the Secrets; pods wait on their Secret volumes until it lands. */
    private async ApplyBootstrap(bootstrap: TenantBootstrap): Promise<void>
    {
        const S = TenantAdminSmoke
        const kubectl = new KubectlCli(this.context)
        this.systemNamespacePreExisted = await this.NamespaceExists(K8sManifestBuilder.SystemNamespace)
        this.applied = true
        await kubectl.Apply(bootstrap.manifest)
        await kubectl.Apply(bootstrap.secrets.RenderManifest())
        console.log(S.InfoTag + S.InfoApplied)
    }

    /** Starts `kubectl port-forward` to the tenant Service on a free local port; resolves with that port once it reports forwarding. */
    private async StartForward(serviceName: string): Promise<number>
    {
        const S = TenantAdminSmoke
        const local = await TenantAdminSmoke.FreePort()
        const child = spawn(S.Kubectl, [S.ContextFlag, this.context, S.NamespaceFlag, K8sManifestBuilder.SystemNamespace, S.PortForwardVerb, S.ServicePrefix + serviceName, `${local}${S.UrlPortSep}${S.TenantPlanePort}`])
        this.forward = child
        await new Promise<void>((resolve, reject) =>
        {
            const timer = setTimeout(() => reject(new Error(S.ForwardTimeoutMessage)), S.ForwardTimeoutMs)
            child.stdout?.on(S.DataEvent, (chunk: Buffer) =>
            {
                if (chunk.toString(S.Utf8).includes(S.ForwardingReady))
                {
                    clearTimeout(timer)
                    resolve()
                }
            })
            child.on(S.ErrorEvent, err =>
            {
                clearTimeout(timer)
                reject(err)
            })
        })
        return local
    }

    private static AsList<T>(json: unknown): T[]
    {
        return Array.isArray(json) ? json as T[] : []
    }

    private static FreePort(): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const server = createServer()
            server.once(TenantAdminSmoke.ErrorEvent, reject)
            server.listen(0, TenantAdminSmoke.LoopbackHost, () =>
            {
                const port = (server.address() as { port: number }).port
                server.close(() => resolve(port))
            })
        })
    }

    private async CheckUnauthenticated(port: number): Promise<void>
    {
        const S = TenantAdminSmoke
        const root = await this.Http(port, S.MethodGet, S.RootPath)
        const contentType = String(root.headers[S.ContentTypeResponseHeader] ?? S.EmptyString)
        this.Expect(S.Labels.SpaServed, root.status === S.StatusOk && contentType.includes(S.HtmlWord), S.StatusWord + String(root.status) + S.Space + contentType)
        const session = await this.Http(port, S.MethodGet, S.SessionPath)
        this.Expect(S.Labels.SessionGate, session.status === S.StatusUnauthorized, S.StatusWord + String(session.status))
        const api = await this.Http(port, S.MethodGet, S.HivesPath)
        this.Expect(S.Labels.ApiGate, api.status === S.StatusUnauthorized, S.StatusWord + String(api.status))
    }

    /** Drives the data API with the seeded session cookie. */
    private async CheckAuthenticated(port: number): Promise<void>
    {
        const S = TenantAdminSmoke
        const session = await this.Http(port, S.MethodGet, S.SessionPath, undefined, true)
        this.Expect(S.Labels.Session, session.status === S.StatusOk && (session.json as SessionDto | undefined)?.principalId === S.SessionPrincipal, S.StatusWord + String(session.status))
        const hives = await this.Http(port, S.MethodGet, S.HivesPath, undefined, true)
        const hiveList = TenantAdminSmoke.AsList<HiveDto>(hives.json)
        this.Expect(S.Labels.Hives, hives.status === S.StatusOk && hiveList.length === 1 && hiveList[0]?.id === S.HiveId, S.StatusWord + String(hives.status))
        const envs = await this.Http(port, S.MethodGet, S.EnvironmentsPath, undefined, true)
        const envList = TenantAdminSmoke.AsList<EnvironmentDto>(envs.json)
        this.Expect(S.Labels.Environments, envs.status === S.StatusOk && envList.some(e => e.name === S.SeedEnvName), S.StatusWord + String(envs.status) + S.DetailSep + envs.text.slice(0, 200))
        const manifests = await this.Http(port, S.MethodGet, S.ManifestsPath, undefined, true)
        const versions = TenantAdminSmoke.AsList<ManifestDto>(manifests.json).map(m => m.id)
        this.Expect(S.Labels.Manifests, manifests.status === S.StatusOk && versions.includes(S.VersionV1) && versions.includes(S.VersionV2), S.StatusWord + String(manifests.status) + S.DetailSep + manifests.text.slice(0, 200))
        const adopt = await this.Http(port, S.MethodPost, S.HivesPrefix + S.HiveId + S.TargetSuffix, JSON.stringify({ [S.VersionKey]: S.VersionV2 }), true)
        this.Expect(S.Labels.Adopt, adopt.status === S.StatusNoContent, S.StatusWord + String(adopt.status) + S.DetailSep + adopt.text.slice(0, 200))
    }

    /** One request through the port-forward with the tenant Host header; mutating requests carry the matching Origin the plane's CSRF check requires. */
    private Http(port: number, method: string, path: string, body?: string, withSession: boolean = false): Promise<HttpResult>
    {
        const S = TenantAdminSmoke
        const headers: Record<string, string> = { [S.HostHeader]: this.tenantHost }
        if (withSession)
        {
            headers[S.CookieHeader] = TenantSessionCookie.Name + '=' + encodeURIComponent(S.TenantId) + S.DotSep + this.sessionToken
        }
        if (method === S.MethodPost)
        {
            headers[S.OriginHeader] = S.HttpPrefix + this.tenantHost
        }
        if (body !== undefined)
        {
            headers[S.ContentTypeHeader] = S.JsonContentType
        }
        return new Promise<HttpResult>((resolve, reject) =>
        {
            const req = request({ host: S.LoopbackHost, port, path, method, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on(S.DataEvent, (c: Buffer) => chunks.push(c))
                res.on(S.EndEvent, () =>
                {
                    const text = Buffer.concat(chunks).toString(S.Utf8)
                    let json: unknown = undefined
                    try
                    {
                        json = text === S.EmptyString ? undefined : JSON.parse(text)
                    }
                    catch
                    {
                        json = undefined
                    }
                    resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
                })
            })
            req.on(S.ErrorEvent, reject)
            if (body !== undefined)
            {
                req.write(body)
            }
            req.end()
        })
    }

    private async NamespaceExists(namespace: string): Promise<boolean>
    {
        const S = TenantAdminSmoke
        try
        {
            await this.exec.Run(S.Kubectl, [S.ContextFlag, this.context, S.GetVerb, S.NamespaceKind, namespace])
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

    /** Prints the pod list plus the init-container and server log tails (redacted) so a failed bring-up is diagnosable. */
    private async Diagnose(): Promise<void>
    {
        const S = TenantAdminSmoke
        if (!this.applied)
        {
            return
        }
        const namespace = K8sManifestBuilder.SystemNamespace
        const deploy = S.DeploymentPrefix + K8sManifestBuilder.TenantAdminNameOf(S.TenantId)
        await this.BestEffort(deploy, async () =>
        {
            const pods = await this.exec.Run(S.Kubectl, [S.ContextFlag, this.context, S.GetVerb, S.PodKind, S.NamespaceFlag, namespace])
            console.log(S.InfoTag + S.InfoPods + KubectlError.Redact(pods.stdout))
        })
        await this.BestEffort(S.SeedContainer, async () =>
        {
            const logs = await this.exec.Run(S.Kubectl, [S.ContextFlag, this.context, S.LogsVerb, deploy, S.ContainerFlag, S.SeedContainer, S.NamespaceFlag, namespace, S.TailFlag])
            console.log(S.InfoTag + S.InfoSeedLogs + KubectlError.Redact(logs.stdout + logs.stderr))
        })
        await this.BestEffort(S.TenantAdminContainer, async () =>
        {
            const logs = await this.exec.Run(S.Kubectl, [S.ContextFlag, this.context, S.LogsVerb, deploy, S.ContainerFlag, S.TenantAdminContainer, S.NamespaceFlag, namespace, S.TailFlag])
            console.log(S.InfoTag + S.InfoAdminLogs + KubectlError.Redact(logs.stdout + logs.stderr))
        })
    }

    /**
     * Always-run cleanup of ONLY this smoke's objects: everything the bootstrap rendered carries the smoke hive label (deleted
     * by selector, each delete independent), the named Secrets are removed, and the shared pragmatic-system namespace is
     * deleted only when this smoke created it.
     */
    private async Cleanup(): Promise<void>
    {
        const S = TenantAdminSmoke
        this.forward?.kill()
        await this.BestEffort(S.ChannelLabel, async () => { await this.channel?.Close() })
        if (this.applied)
        {
            const selector = S.HiveSelectorPrefix + S.HiveId
            const namespace = K8sManifestBuilder.SystemNamespace
            await this.BestEffort(S.NamespacedKinds, async () =>
            {
                await this.exec.Run(S.Kubectl, [S.ContextFlag, this.context, S.DeleteVerb, S.NamespacedKinds, S.NamespaceFlag, namespace, S.SelectorFlag, selector, S.IgnoreNotFoundFlag])
            })
            await this.BestEffort(S.ClusterKinds, async () =>
            {
                await this.exec.Run(S.Kubectl, [S.ContextFlag, this.context, S.DeleteVerb, S.ClusterKinds, S.SelectorFlag, selector, S.IgnoreNotFoundFlag])
            })
            for (const name of this.bootstrap?.secrets.Names() ?? [])
            {
                await this.BestEffort(name, async () =>
                {
                    await this.exec.Run(S.Kubectl, [S.ContextFlag, this.context, S.DeleteVerb, S.SecretKind, name, S.NamespaceFlag, namespace, S.IgnoreNotFoundFlag])
                })
            }
            if (!this.systemNamespacePreExisted)
            {
                await this.BestEffort(namespace, async () => { await new KubectlCli(this.context).DeleteNamespace(namespace) })
            }
        }
        if (this.tempDir !== undefined)
        {
            const dir = this.tempDir
            await this.BestEffort(dir, () => rm(dir, { recursive: true, force: true }))
        }
    }

    private async BestEffort(what: string, action: () => Promise<unknown>): Promise<void>
    {
        const S = TenantAdminSmoke
        try
        {
            await action()
        }
        catch (e)
        {
            console.log(S.TeardownWarning + what + S.DetailSep + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
    }

    private Expect(label: string, ok: boolean, detail: string = TenantAdminSmoke.EmptyString): void
    {
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === TenantAdminSmoke.EmptyString ? TenantAdminSmoke.EmptyString : TenantAdminSmoke.DetailSep + KubectlError.Redact(detail)
        console.log((ok ? TenantAdminSmoke.PassTag : TenantAdminSmoke.FailTag) + label + suffix)
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (TenantAdminSmoke.IsEntryPoint())
{
    await TenantAdminSmoke.Main()
}
