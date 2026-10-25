import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentService } from './environment-service.js'
import { HiveHealthProducer } from './hive-health-producer.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { ExecFileDockerExec, IdpContainerEnv } from './idp-container-env.js'
import { IdpAdminClient } from './idp-admin-client.js'
import { IdpRegistry } from './idp-registry.js'
import { IdpService } from './idp-service.js'
import { MasterKeyFile } from './master-key-file.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'
import { ControlPlaneServer } from './server.js'
import { SeededTenantDirectory, type TenantDirectorySeed } from './tenant-api/seeded-tenant-directory.js'
import type { IRolloutClient } from './tenant-api/rollout-client.js'
import { UnconfiguredRolloutClient } from './tenant-api/unconfigured-rollout-client.js'
import { TenantAdminClientRegistry } from './tenant-auth/tenant-admin-client-record.js'
import { TenantHostResolver } from './tenant-auth/tenant-host-resolver.js'
import type { TenantPlane } from './tenant-auth/tenant-plane.js'
import { TenantHealthMonitor } from './tenant-health-monitor.js'
import { TenantPlaneHost } from './tenant-plane-host.js'

export type TenantAdminConfig = {
    readonly dataRoot: string
    readonly port: number
    readonly bind: string
    readonly baseDomain: string
    readonly scheme: string
    readonly secureCookie: boolean
    readonly secretTtlHours: number
    readonly probeMs: number
    readonly probeTimeoutMs: number
}

export type TenantAdminComposition = {
    readonly directory: SeededTenantDirectory
    readonly rollout: IRolloutClient
    readonly plane: TenantPlane
    readonly host: TenantPlaneHost
    readonly monitor: TenantHealthMonitor | undefined
    readonly config: TenantAdminConfig
}

/**
 * The standalone tenant-admin process: boots ONLY the tenant plane over its own data root. Tenant and hive identity
 * come from a seed file (`seed.json`) instead of the operator's PlatformDirectory, and rollout reads/actions go
 * through an injected IRolloutClient. There is no operator plane and no agent channel here.
 */
export class TenantAdminServer
{
    private static readonly DataRootEnvVar = 'PRAGMATIC_TENANT_ADMIN_DATA_ROOT'
    private static readonly PortEnvVar = 'PRAGMATIC_TENANT_ADMIN_PORT'
    private static readonly BindEnvVar = 'PRAGMATIC_TENANT_ADMIN_BIND'
    private static readonly BaseDomainEnvVar = 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN'
    private static readonly SchemeEnvVar = 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME'
    private static readonly SecureCookieEnvVar = 'PRAGMATIC_TENANT_ADMIN_SECURE_COOKIE'
    private static readonly SecretTtlEnvVar = 'PRAGMATIC_TENANT_ADMIN_SECRET_TTL_HOURS'
    private static readonly HealthProbeMsEnvVar = 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS'
    private static readonly HealthProbeTimeoutMsEnvVar = 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_TIMEOUT_MS'
    private static readonly MissingEnvPrefix = 'Missing required environment variable: '
    private static readonly MissingSeedPrefix = 'Tenant-admin seed file not found: '
    private static readonly BadSeedMessage = 'Invalid seed.json: expected { tenant, hives[] }'
    private static readonly MissingMasterKeyPrefix = 'Tenant-admin master key file not found: '
    private static readonly SeedFile = 'seed.json'
    private static readonly MasterKeyFileName = 'master.key'
    private static readonly RegistryFile = 'registry.json'
    private static readonly IdpsFile = 'idps.json'
    private static readonly TenantAdminClientsFile = 'tenant-admin-clients.json'
    private static readonly ParentSegment = '..'
    private static readonly TenantPortalSegment = 'tenant-portal'
    private static readonly DistSegment = 'dist'
    private static readonly IdpPortFloor = 12100
    private static readonly EnvPortFloor = 8100
    private static readonly TrueToken = 'true'
    private static readonly OneToken = '1'
    private static readonly SchemeHostSeparator = '://'
    private static readonly HostPortSeparator = ':'
    private static readonly ListeningPrefix = 'Tenant plane listening on '
    private static readonly ListeningSuffix = '/'
    private static readonly Utf8 = 'utf8'

    public constructor(
        private readonly config: TenantAdminConfig,
        private readonly rollout: IRolloutClient)
    {
    }

    /** Entry point used by the bin: reads config from the environment and runs with the default rollout client. */
    public static async Main(): Promise<void>
    {
        const config = TenantAdminServer.ReadConfig(process.env)
        await new TenantAdminServer(config, TenantAdminServer.DefaultRolloutClient()).Run()
    }

    /** The default rollout client; the in-container HTTP client replaces it when the operator link is wired. */
    public static DefaultRolloutClient(): IRolloutClient
    {
        return new UnconfiguredRolloutClient()
    }

    /** Pure: derives the config from the environment; a missing required variable throws naming it. */
    public static ReadConfig(env: NodeJS.ProcessEnv): TenantAdminConfig
    {
        const dataRoot = TenantAdminServer.Required(env, TenantAdminServer.DataRootEnvVar)
        const portRaw = TenantAdminServer.Required(env, TenantAdminServer.PortEnvVar)
        const baseDomain = TenantAdminServer.Required(env, TenantAdminServer.BaseDomainEnvVar)
        const secure = env[TenantAdminServer.SecureCookieEnvVar]
        return {
            dataRoot,
            port: ControlPlaneServer.ResolveTenantPort(portRaw),
            bind: ControlPlaneServer.TenantBind(env[TenantAdminServer.BindEnvVar]),
            baseDomain,
            scheme: ControlPlaneServer.TenantScheme(env[TenantAdminServer.SchemeEnvVar]),
            secureCookie: secure === TenantAdminServer.TrueToken || secure === TenantAdminServer.OneToken,
            secretTtlHours: ControlPlaneServer.ParseSecretTtlHours(env[TenantAdminServer.SecretTtlEnvVar]),
            probeMs: ControlPlaneServer.ParseHealthProbeMs(env[TenantAdminServer.HealthProbeMsEnvVar]),
            probeTimeoutMs: ControlPlaneServer.ParseHealthProbeTimeoutMs(env[TenantAdminServer.HealthProbeTimeoutMsEnvVar]),
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
        return new SeededTenantDirectory({ tenant: seed.tenant, hives: seed.hives })
    }

    /**
     * Builds the whole tenant plane over this process's own data root without binding anything: seeded directory,
     * stores, services, plane, host and health monitor.
     */
    public async Compose(): Promise<TenantAdminComposition>
    {
        const cfg = this.config
        const dataRoot = cfg.dataRoot
        mkdirSync(dataRoot, { recursive: true })
        const directory = TenantAdminServer.LoadSeed(dataRoot)
        const keyPath = join(dataRoot, TenantAdminServer.MasterKeyFileName)
        if (!existsSync(keyPath))
        {
            throw new Error(TenantAdminServer.MissingMasterKeyPrefix + keyPath)
        }
        const masterKey = MasterKeyFile.Load(keyPath)
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(dataRoot, TenantAdminServer.RegistryFile), docker)
        await registry.Load()
        const adminClients = new TenantAdminClientRegistry(join(dataRoot, TenantAdminServer.TenantAdminClientsFile))
        await adminClients.Load()
        const idpService = new IdpService(new PortAllocator(TenantAdminServer.IdpPortFloor, new NetPortProbe()), new IdpContainerEnv(new ExecFileDockerExec()), new IdpRegistry(join(dataRoot, TenantAdminServer.IdpsFile)), dataRoot, DockerEnv.ImageName)
        const service = new EnvironmentService(registry, new PortAllocator(TenantAdminServer.EnvPortFloor, new NetPortProbe()), docker, new BundleBuilderAdapter(), new UserSeederAdapter(new UserSeeder()), dataRoot, new AdminProxy(new WsAdminConnector()), directory, idpService, conn => new IdpAdminClient(conn))
        const orchestrators = new HiveOrchestratorFactory()
        const placement = new EnvironmentPlacement(directory)
        const plane = ControlPlaneServer.ComposeTenantPlane(
            TenantAdminServer.PlaneEnv(cfg), dataRoot, idpService, directory, cfg.secureCookie, service, this.rollout, orchestrators, placement,
            masterKey, adminClients, cfg.secretTtlHours)
        if (plane === undefined)
        {
            throw new Error(TenantAdminServer.MissingEnvPrefix + TenantAdminServer.PortEnvVar)
        }
        const resolver = new TenantHostResolver(cfg.baseDomain, cfg.scheme, directory)
        const staticRoot = join(dirname(fileURLToPath(import.meta.url)), TenantAdminServer.ParentSegment, TenantAdminServer.TenantPortalSegment, TenantAdminServer.DistSegment)
        const monitor = cfg.probeMs > 0
            ? new TenantHealthMonitor(directory, new HiveHealthProducer(service, orchestrators, placement), plane.events, cfg.probeMs, cfg.probeTimeoutMs)
            : undefined
        const host = new TenantPlaneHost(plane, resolver, staticRoot, service, monitor)
        return { directory, rollout: this.rollout, plane, host, monitor, config: cfg }
    }

    /** Composes then binds the tenant listener. */
    public async Run(): Promise<void>
    {
        const composition = await this.Compose()
        const cfg = composition.config
        await composition.host.Listen(cfg.port, cfg.bind)
        console.log(TenantAdminServer.ListeningPrefix + cfg.scheme + TenantAdminServer.SchemeHostSeparator + cfg.baseDomain + TenantAdminServer.HostPortSeparator + String(cfg.port) + TenantAdminServer.ListeningSuffix)
    }

    /** ComposeTenantPlane activates off the env pair; rebuild it from the already-validated config. */
    private static PlaneEnv(cfg: TenantAdminConfig): NodeJS.ProcessEnv
    {
        return { [TenantAdminServer.PortEnvVar]: String(cfg.port), [TenantAdminServer.BaseDomainEnvVar]: cfg.baseDomain }
    }

    private static Required(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = env[name]
        if (value === undefined || value === '')
        {
            throw new Error(TenantAdminServer.MissingEnvPrefix + name)
        }
        return value
    }
}
