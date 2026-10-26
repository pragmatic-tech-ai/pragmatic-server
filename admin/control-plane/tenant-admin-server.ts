import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { DockerEnvironmentRuntime } from './environment-runtime.js'
import { EnvironmentRuntimeResolver } from './environment-runtime-resolver.js'
import { InClusterEnvironmentRuntime } from './in-cluster-environment-runtime.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentService } from './environment-service.js'
import { HiveHealthProducer } from './hive-health-producer.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { ExecFileDockerExec, IdpContainerEnv } from './idp-container-env.js'
import { IdpAdminClient } from './idp-admin-client.js'
import { IdpRegistry } from './idp-registry.js'
import { DockerIdpDriver } from './docker-idp-driver.js'
import { IdpService } from './idp-service.js'
import { MasterKeyFile } from './master-key-file.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'
import { ControlPlaneServer } from './server.js'
import { SeededTenantDirectory, type TenantDirectorySeed } from './tenant-api/seeded-tenant-directory.js'
import type { IRolloutClient } from './tenant-api/rollout-client.js'
import { UnconfiguredRolloutClient } from './tenant-api/unconfigured-rollout-client.js'
import { TenantAdminEnv } from './tenant-admin-env.js'
import { HttpRolloutClient } from './tenant-api/http-rollout-client.js'
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
            secureCookie: secure === TenantAdminServer.TrueToken || secure === TenantAdminServer.OneToken,
            secretTtlHours: ControlPlaneServer.ParseSecretTtlHours(env[TenantAdminEnv.SecretTtl]),
            probeMs: ControlPlaneServer.ParseHealthProbeMs(env[TenantAdminEnv.HealthProbeMs]),
            probeTimeoutMs: ControlPlaneServer.ParseHealthProbeTimeoutMs(env[TenantAdminEnv.HealthProbeTimeoutMs]),
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
     * stores, services, plane, host and health monitor.
     */
    public async Compose(): Promise<TenantAdminComposition>
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
        const idpService = new IdpService(new IdpRegistry(join(dataRoot, ControlPlaneServer.IdpsFile)), new DockerIdpDriver(new PortAllocator(ControlPlaneServer.IdpPortFloor, new NetPortProbe()), new IdpContainerEnv(new ExecFileDockerExec()), dataRoot, DockerEnv.ImageName))
        const orchestrators = new HiveOrchestratorFactory()
        const placement = new EnvironmentPlacement(directory)
        const service = new EnvironmentService(registry, new PortAllocator(ControlPlaneServer.EnvPortFloor, new NetPortProbe()), new EnvironmentRuntimeResolver(new DockerEnvironmentRuntime(docker, new BundleBuilderAdapter()), new InClusterEnvironmentRuntime(orchestrators, placement, directory, new BundleBuilderAdapter()), directory, orchestrators), new UserSeederAdapter(new UserSeeder()), dataRoot, new AdminProxy(new WsAdminConnector()), directory, idpService, conn => new IdpAdminClient(conn))
        const plane = ControlPlaneServer.BuildTenantPlane(
            dataRoot, idpService, directory, cfg.secureCookie, service, this.rollout, orchestrators, placement,
            masterKey, adminClients, cfg.secretTtlHours)
        const resolver = new TenantHostResolver(cfg.baseDomain, cfg.scheme, directory)
        const staticRoot = join(dirname(fileURLToPath(import.meta.url)), ControlPlaneServer.ParentSegment, ControlPlaneServer.TenantPortalSegment, ControlPlaneServer.DistSegment)
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
        console.log(TenantAdminServer.ListeningLine(cfg))
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
