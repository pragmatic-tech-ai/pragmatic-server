import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { DockerEnvironmentRuntime } from './environment-runtime.js'
import { EnvironmentRuntimeResolver } from './environment-runtime-resolver.js'
import { InClusterEnvironmentReach } from './in-cluster-environment-reach.js'
import { InClusterEnvironmentRuntime } from './in-cluster-environment-runtime.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentService } from './environment-service.js'
import type { IEnvironmentReach } from './environment-endpoints.js'
import { HiveHealthProducer } from './hive-health-producer.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import type { InClusterOrchestration } from './in-cluster-hive-orchestrator.js'
import { IngressTlsPolicy, type IngressTls } from './ingress-tls.js'
import { HttpsKubeTransport, InClusterServiceAccount, KubeApiClient } from './kube-api-client.js'
import { PinnedImageVerifier } from './pinned-image-verifier.js'
import { TenantAdminBootstrap } from './tenant-admin-bootstrap.js'
import { ExecFileDockerExec, IdpContainerEnv } from './idp-container-env.js'
import { IdpAdminClient } from './idp-admin-client.js'
import { IdpRegistry } from './idp-registry.js'
import { DockerIdpDriver } from './docker-idp-driver.js'
import { IdpService, type IIdpService } from './idp-service.js'
import { InjectedIdpService } from './injected-idp-service.js'
import { MasterKeyFile } from './master-key-file.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'
import { ControlPlaneServer } from './server.js'
import type { HiveRecord, TenantRecord } from './platform-records.js'
import { ConsoleFingerprint } from './console-advert-contract.js'
import { ConsoleAdvertSender, HttpConsoleAdvertTransport, IntervalAdvertTimer, SeededConsoleAccounts } from './console-advert-sender.js'
import { ConsoleEmailDomainStore } from './console-email-domain-store.js'
import { ConsoleFingerprintKeys } from './console-fingerprint-keys.js'
import { SeededTenantDirectory, type TenantDirectorySeed } from './tenant-api/seeded-tenant-directory.js'
import type { IRolloutClient } from './tenant-api/rollout-client.js'
import { UnconfiguredRolloutClient } from './tenant-api/unconfigured-rollout-client.js'
import { TenantAdminEnv } from './tenant-admin-env.js'
import { HttpRolloutClient } from './tenant-api/http-rollout-client.js'
import { TenantAdminClientRegistry } from './tenant-auth/tenant-admin-client-record.js'
import { TenantHostResolver, type ConsoleHostAlias } from './tenant-auth/tenant-host-resolver.js'
import type { TenantPlane } from './tenant-auth/tenant-plane.js'
import { TenantHealthMonitor } from './tenant-health-monitor.js'
import { TenantPlaneHost } from './tenant-plane-host.js'

export type TenantAdminConfig = {
    readonly dataRoot: string
    readonly port: number
    readonly bind: string
    readonly baseDomain: string
    readonly scheme: string
    /** The tenant origin's externally visible port, when it is not the scheme default (proxy-less runs). */
    readonly externalPort: number | undefined
    readonly secureCookie: boolean
    /** Whether the tenant listener is behind a trusted proxy (PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY). */
    readonly trustedProxy: boolean
    readonly secretTtlHours: number
    readonly probeMs: number
    readonly probeTimeoutMs: number
    /** The console's own host (PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST); it answers for the seeded tenant. */
    readonly consoleHost: string | undefined
    /** Path of the mounted account-email fingerprint key (PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE); undefined outside a console pod. */
    readonly fingerprintKeyFile: string | undefined
    /** How environment Ingresses get TLS; undefined = none configured. */
    readonly ingressTls: IngressTls | undefined
}

export type TenantAdminComposition = {
    readonly directory: SeededTenantDirectory
    readonly rollout: IRolloutClient
    readonly plane: TenantPlane
    readonly host: TenantPlaneHost
    readonly monitor: TenantHealthMonitor | undefined
    readonly config: TenantAdminConfig
    /** How this console reaches environments in its own hive; undefined outside a pod. */
    readonly reach: IEnvironmentReach | undefined
    /** The console's own email domains (`<dataRoot>/email-domains.json`, seeded from the tenant record). */
    readonly emailDomains: ConsoleEmailDomainStore
    /** Tells the control plane about this console; undefined unless every advert setting is present (a real console pod). */
    readonly advert: ConsoleAdvertSender | undefined
}

/**
 * The standalone tenant-admin process: boots ONLY the tenant plane over its own data root. Tenant and hive identity
 * come from a seed file (`seed.json`) instead of the operator's PlatformDirectory, and rollout reads/actions go
 * through an injected IRolloutClient. There is no operator plane and no agent channel here.
 */
export class TenantAdminServer
{
    private static readonly MissingEnvPrefix = 'Missing required environment variable: '
    private static readonly MissingSeedPrefix = 'Tenant-admin seed file not found: '
    private static readonly BadSeedMessage = 'Invalid seed.json: expected { tenant, hives[] }'
    private static readonly MissingMasterKeyPrefix = 'Tenant-admin master key file not found: '
    private static readonly SeedFile = 'seed.json'
    private static readonly TrueToken = 'true'
    private static readonly OneToken = '1'
    private static readonly ListeningTemplate = 'Tenant plane listening on {scheme}://{domain}:{port}/'
    private static readonly SchemeToken = '{scheme}'
    private static readonly DomainToken = '{domain}'
    private static readonly PortToken = '{port}'
    private static readonly BadHiveMessage = 'Invalid seed.json: every hive needs string id, tenantId, displayName, createdAt and object cluster, registry'
    private static readonly HiveStringFields = ['id', 'tenantId', 'displayName', 'createdAt'] as const
    private static readonly HiveObjectFields = ['cluster', 'registry'] as const
    private static readonly Utf8 = 'utf8'
    private static readonly EmptyString = ''
    private static readonly NoIdentityMessage = 'The seed names no hive for the in-cluster console.'
    private static readonly ConsoleUrlScheme = 'https://'
    private static readonly AdvertOffPrefix = '[console-advert] off: '
    private static readonly NotSetSuffix = ' is not set'
    private static readonly BadKeyInfix = ' does not name a readable key file of '
    private static readonly BytesSuffix = ' bytes'

    private running: TenantAdminComposition | undefined

    public constructor(
        private readonly config: TenantAdminConfig,
        private readonly rollout: IRolloutClient)
    {
    }

    /** Entry point used by the bin: reads config from the environment and runs with the default rollout client. */
    public static async Main(): Promise<void>
    {
        const config = TenantAdminServer.ReadConfig(process.env)
        await new TenantAdminServer(config, TenantAdminServer.RolloutClientFrom(process.env)).Run()
    }

    /** The HTTP rollout client when the agent-channel URL is configured (token + hive id then required); otherwise the default. */
    public static RolloutClientFrom(env: NodeJS.ProcessEnv): IRolloutClient
    {
        const url = env[TenantAdminEnv.RolloutUrl]
        if (url === undefined || url === TenantAdminServer.EmptyString)
        {
            return TenantAdminServer.DefaultRolloutClient()
        }
        return new HttpRolloutClient(
            url,
            TenantAdminServer.Required(env, TenantAdminEnv.RolloutToken),
            TenantAdminServer.Required(env, TenantAdminEnv.RolloutHiveId))
    }

    /** The default rollout client; the in-container HTTP client replaces it when the operator link is wired. */
    public static DefaultRolloutClient(): IRolloutClient
    {
        return new UnconfiguredRolloutClient()
    }

    /** Pure: derives the config from the environment; a missing required variable throws naming it. */
    public static ReadConfig(env: NodeJS.ProcessEnv): TenantAdminConfig
    {
        const dataRoot = TenantAdminServer.Required(env, TenantAdminEnv.DataRoot)
        const portRaw = TenantAdminServer.Required(env, TenantAdminEnv.Port)
        const baseDomain = TenantAdminServer.Required(env, TenantAdminEnv.BaseDomain)
        const secure = env[TenantAdminEnv.SecureCookie]
        return {
            dataRoot,
            port: ControlPlaneServer.ResolveTenantPort(portRaw),
            bind: ControlPlaneServer.TenantBind(env[TenantAdminEnv.Bind]),
            baseDomain,
            scheme: ControlPlaneServer.TenantScheme(env[TenantAdminEnv.Scheme]),
            externalPort: ControlPlaneServer.TenantExternalPort(env[TenantAdminEnv.ExternalPort]),
            secureCookie: secure === TenantAdminServer.TrueToken || secure === TenantAdminServer.OneToken,
            trustedProxy: ControlPlaneServer.ReadsTrue(env[TenantAdminEnv.TrustedProxy]),
            secretTtlHours: ControlPlaneServer.ParseSecretTtlHours(env[TenantAdminEnv.SecretTtl]),
            probeMs: ControlPlaneServer.ParseHealthProbeMs(env[TenantAdminEnv.HealthProbeMs]),
            probeTimeoutMs: ControlPlaneServer.ParseHealthProbeTimeoutMs(env[TenantAdminEnv.HealthProbeTimeoutMs]),
            consoleHost: TenantAdminServer.OptionalOf(env, TenantAdminEnv.ConsoleHost),
            fingerprintKeyFile: TenantAdminServer.OptionalOf(env, TenantAdminEnv.FingerprintKeyFile),
            ingressTls: IngressTlsPolicy.FromEnv(env),
        }
    }

    /**
     * The console's advert sender: undefined (and one log line naming the missing setting's env var, never a value) unless
     * consoleHost, a ConsoleFingerprintKeys.KeyBytes key file and RolloutUrl / RolloutToken / RolloutHiveId are all present.
     * It dials home over the same agent channel, bearer and hive as the HTTP rollout client. consoleUrl = 'https://' + consoleHost.
     */
    public static AdvertSenderOf(env: NodeJS.ProcessEnv, cfg: TenantAdminConfig, tenant: TenantRecord, domains: ConsoleEmailDomainStore, log: (line: string) => void = TenantAdminServer.LogLine): ConsoleAdvertSender | undefined
    {
        const S = TenantAdminServer
        const url = S.OptionalOf(env, TenantAdminEnv.RolloutUrl)
        const token = S.OptionalOf(env, TenantAdminEnv.RolloutToken)
        const hiveId = S.OptionalOf(env, TenantAdminEnv.RolloutHiveId)
        if (cfg.consoleHost === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.ConsoleHost + S.NotSetSuffix)
        }
        if (cfg.fingerprintKeyFile === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.FingerprintKeyFile + S.NotSetSuffix)
        }
        if (url === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.RolloutUrl + S.NotSetSuffix)
        }
        if (token === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.RolloutToken + S.NotSetSuffix)
        }
        if (hiveId === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.RolloutHiveId + S.NotSetSuffix)
        }
        const key = ConsoleFingerprint.ReadKeyFile(cfg.fingerprintKeyFile)
        if (key === undefined)
        {
            return S.AdvertOff(log, TenantAdminEnv.FingerprintKeyFile + S.BadKeyInfix + ConsoleFingerprintKeys.KeyBytes + S.BytesSuffix)
        }
        return new ConsoleAdvertSender(new HttpConsoleAdvertTransport(url, token, hiveId), new SeededConsoleAccounts(tenant), domains, key,
            S.ConsoleUrlScheme + cfg.consoleHost, new IntervalAdvertTimer(), log)
    }

    /**
     * In-cluster the operator provisioned the IdP, so the pod only CONNECTS (injected env + mounted Secret files);
     * otherwise the dev-collapse docker-backed IdpService launches one.
     */
    public static BuildIdpService(env: NodeJS.ProcessEnv, dataRoot: string): IIdpService
    {
        return InjectedIdpService.FromEnv(env)
            ?? new IdpService(new IdpRegistry(join(dataRoot, ControlPlaneServer.IdpsFile)), new DockerIdpDriver(new PortAllocator(ControlPlaneServer.IdpPortFloor, new NetPortProbe()), new IdpContainerEnv(new ExecFileDockerExec()), dataRoot, DockerEnv.ImageName))
    }

    /**
     * What the console needs to orchestrate its own hive through the Kubernetes API: the API client over the pod's service
     * account, the identity from the seed (tenant + the hive it was installed into) and the pinned-image allow-list the
     * platform left in the data root. No network call.
     */
    public static InClusterOrchestrationOf(account: InClusterServiceAccount, directory: SeededTenantDirectory, dataRoot: string): InClusterOrchestration
    {
        const hive = TenantAdminServer.FirstHiveOf(directory)
        return {
            client: new KubeApiClient(new HttpsKubeTransport(account)),
            identity: { tenantId: hive.tenantId, hiveId: hive.id },
            verifier: PinnedImageVerifier.Load(join(dataRoot, TenantAdminBootstrap.VerifiedImagesKey)),
        }
    }

    /** Reads `<dataRoot>/seed.json` and builds the single-tenant directory view from it. */
    public static LoadSeed(dataRoot: string): SeededTenantDirectory
    {
        const path = join(dataRoot, TenantAdminServer.SeedFile)
        if (!existsSync(path))
        {
            throw new Error(TenantAdminServer.MissingSeedPrefix + path)
        }
        const seed = JSON.parse(readFileSync(path, TenantAdminServer.Utf8)) as Partial<TenantDirectorySeed> | null
        if (seed === null || typeof seed !== 'object' || seed.tenant === undefined || typeof seed.tenant.id !== 'string' || !Array.isArray(seed.hives))
        {
            throw new Error(TenantAdminServer.BadSeedMessage)
        }
        if (!seed.hives.every(h => TenantAdminServer.IsHive(h)))
        {
            throw new Error(TenantAdminServer.BadHiveMessage)
        }
        return new SeededTenantDirectory({ tenant: seed.tenant, hives: seed.hives })
    }

    /**
     * Builds the whole tenant plane over this process's own data root without binding anything: seeded directory,
     * stores, services, plane, host, health monitor, the console's email domains and (in a configured console) its advert sender.
     */
    public async Compose(env: NodeJS.ProcessEnv = process.env, serviceAccountRoot?: string, log: (line: string) => void = TenantAdminServer.LogLine): Promise<TenantAdminComposition>
    {
        const cfg = this.config
        const dataRoot = cfg.dataRoot
        const directory = TenantAdminServer.LoadSeed(dataRoot)
        const keyPath = join(dataRoot, ControlPlaneServer.MasterKeyFileName)
        if (!existsSync(keyPath))
        {
            throw new Error(TenantAdminServer.MissingMasterKeyPrefix + keyPath)
        }
        const masterKey = MasterKeyFile.Load(keyPath)
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(dataRoot, ControlPlaneServer.RegistryFile), docker)
        await registry.Load()
        const adminClients = new TenantAdminClientRegistry(join(dataRoot, ControlPlaneServer.TenantAdminClientsFile))
        await adminClients.Load()
        const idpService = TenantAdminServer.BuildIdpService(env, dataRoot)
        const account = InClusterServiceAccount.Detect(env, serviceAccountRoot)
        const inCluster = account === undefined ? undefined : TenantAdminServer.InClusterOrchestrationOf(account, directory, dataRoot)
        const orchestrators = inCluster === undefined ? new HiveOrchestratorFactory() : new HiveOrchestratorFactory(undefined, dataRoot, inCluster)
        const placement = new EnvironmentPlacement(directory, cfg.ingressTls)
        const reach = inCluster === undefined ? undefined : new InClusterEnvironmentReach(orchestrators.For(TenantAdminServer.FirstHiveOf(directory)).Kubectl)
        // No PlatformImageSigner here, deliberately: the platform signing key's private half never ships into a hive, so
        // the in-hive tenant admin cannot sign. It runs only images the platform signed (its hive's verification decides).
        const service = new EnvironmentService(registry, new PortAllocator(ControlPlaneServer.EnvPortFloor, new NetPortProbe()), new EnvironmentRuntimeResolver(new DockerEnvironmentRuntime(docker, new BundleBuilderAdapter()), new InClusterEnvironmentRuntime(orchestrators, placement, directory, new BundleBuilderAdapter()), directory, orchestrators), new UserSeederAdapter(new UserSeeder()), dataRoot, new AdminProxy(new WsAdminConnector()), directory, idpService, conn => new IdpAdminClient(conn), undefined, reach)
        const tenant = directory.Tenant
        const emailDomains = await ConsoleEmailDomainStore.Open(join(dataRoot, ConsoleEmailDomainStore.FileName), tenant.id, tenant.emailDomains)
        const plane = ControlPlaneServer.BuildTenantPlane(
            dataRoot, idpService, directory, cfg.secureCookie, service, this.rollout, orchestrators, placement,
            masterKey, adminClients, cfg.secretTtlHours, undefined, undefined, cfg.trustedProxy, false, undefined, emailDomains)
        const resolver = new TenantHostResolver(cfg.baseDomain, cfg.scheme, directory, cfg.externalPort, TenantAdminServer.ConsoleAliasOf(cfg, directory))
        const staticRoot = join(dirname(fileURLToPath(import.meta.url)), ControlPlaneServer.ParentSegment, ControlPlaneServer.TenantPortalSegment, ControlPlaneServer.DistSegment)
        const monitor = cfg.probeMs > 0
            ? new TenantHealthMonitor(directory, new HiveHealthProducer(service, orchestrators, placement), plane.events, cfg.probeMs, cfg.probeTimeoutMs, service)
            : undefined
        const host = new TenantPlaneHost(plane, resolver, staticRoot, service, monitor)
        const advert = TenantAdminServer.AdvertSenderOf(env, cfg, tenant, emailDomains, log)
        return { directory, rollout: this.rollout, plane, host, monitor, config: cfg, reach, emailDomains, advert }
    }

    /** Composes, binds the tenant listener, then starts the advert (its first send awaited; a failure is logged, never thrown). */
    public async Run(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = TenantAdminServer.LogLine): Promise<TenantAdminComposition>
    {
        const composition = await this.Compose(env, undefined, log)
        const cfg = composition.config
        await composition.host.Listen(cfg.port, cfg.bind)
        // Only a listener that bound counts as running, so Close after a failed Listen has nothing to stop.
        this.running = composition
        console.log(TenantAdminServer.ListeningLine(cfg))
        await composition.advert?.Start()
        return composition
    }

    /**
     * Stops the advert (aborting a send in flight and waiting for it to end, so nothing is logged afterwards) and closes the
     * tenant listener started by Run; a no-op when nothing runs.
     */
    public async Close(): Promise<void>
    {
        const composition = this.running
        this.running = undefined
        if (composition === undefined)
        {
            return
        }
        composition.advert?.Stop()
        await composition.advert?.Idle()
        await composition.host.Close()
    }

    private static AdvertOff(log: (line: string) => void, reason: string): undefined
    {
        log(TenantAdminServer.AdvertOffPrefix + reason)
        return undefined
    }

    private static LogLine(line: string): void
    {
        console.error(line)
    }

    private static ListeningLine(cfg: TenantAdminConfig): string
    {
        return TenantAdminServer.ListeningTemplate
            .replace(TenantAdminServer.SchemeToken, cfg.scheme)
            .replace(TenantAdminServer.DomainToken, cfg.baseDomain)
            .replace(TenantAdminServer.PortToken, String(cfg.port))
    }

    /** True when the value is a well-formed HiveRecord: required string fields non-empty, cluster/registry objects. */
    private static IsHive(value: unknown): boolean
    {
        if (value === null || typeof value !== 'object')
        {
            return false
        }
        const rec = value as Record<string, unknown>
        return TenantAdminServer.HiveStringFields.every(f => typeof rec[f] === 'string' && rec[f] !== TenantAdminServer.EmptyString)
            && TenantAdminServer.HiveObjectFields.every(f => typeof rec[f] === 'object' && rec[f] !== null)
    }

    private static ConsoleAliasOf(cfg: TenantAdminConfig, directory: SeededTenantDirectory): ConsoleHostAlias | undefined
    {
        return cfg.consoleHost === undefined ? undefined : { host: cfg.consoleHost, tenantId: TenantAdminServer.FirstHiveOf(directory).tenantId }
    }

    /** The seed's first hive: the console's own identity. Throws NoIdentityMessage when the seed has none. */
    private static FirstHiveOf(directory: SeededTenantDirectory): HiveRecord
    {
        const hive = directory.ListHives()[0]
        if (hive === undefined)
        {
            throw new Error(TenantAdminServer.NoIdentityMessage)
        }
        return hive
    }

    private static OptionalOf(env: NodeJS.ProcessEnv, name: string): string | undefined
    {
        const value = env[name]
        return value === undefined || value === TenantAdminServer.EmptyString ? undefined : value
    }

    private static Required(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = env[name]
        if (value === undefined || value === TenantAdminServer.EmptyString)
        {
            throw new Error(TenantAdminServer.MissingEnvPrefix + name)
        }
        return value
    }
}
