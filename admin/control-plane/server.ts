import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { ControlPlaneHost } from './control-plane-host.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { ManifestRegistry } from './manifest-record.js'
import { GatingRegistry } from './gating-record.js'
import { SelectionRegistry } from './selection-record.js'
import { RolloutReportRegistry } from './rollout-report-record.js'
import { RolloutRegistrationRegistry } from './rollout-registration-record.js'
import { PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { ClientRegistry } from './client-registry.js'
import { HiveRegistry } from './hive-registry.js'
import { PlatformDirectory } from './platform-directory.js'
import { TenantRegistry } from './tenant-registry.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentService } from './environment-service.js'
import { GraphService } from './graph-service.js'
import { OperatorIdentity, type OperatorComposeOptions } from './operator-identity.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'
import { ExecFileDockerExec, IdpContainerEnv } from './idp-container-env.js'
import { IdpRegistry } from './idp-registry.js'
import { IdpService } from './idp-service.js'
import { IdpAdminClient } from './idp-admin-client.js'
import { TenantProvisioningService } from './tenant-provisioning-service.js'
import { TenantSessionStore } from './tenant-auth/tenant-session.js'
import { TenantOidcRelyingParty, type TenantAdminDurability } from './tenant-auth/tenant-oidc-relying-party.js'
import { TenantAdminClientRegistry } from './tenant-auth/tenant-admin-client-record.js'
import { MasterKeyFile } from './master-key-file.js'
import { TenantAuthEndpoint } from './tenant-auth/tenant-auth-endpoint.js'
import { TenantAuthGate } from './tenant-auth/tenant-auth-gate.js'
import { TenantHostResolver } from './tenant-auth/tenant-host-resolver.js'
import { TenantApiEndpoint } from './tenant-api/tenant-api-endpoint.js'
import { TenantEventBus } from './tenant-api/tenant-events.js'
import { TenantPlaneHost } from './tenant-plane-host.js'
import { TenantHealthMonitor } from './tenant-health-monitor.js'
import { HiveHealthProducer } from './hive-health-producer.js'
import type { TenantPlane } from './tenant-auth/tenant-plane.js'
import type { IEnvironmentService } from './control-plane-host.js'

export class ControlPlaneServer
{
    private static readonly PortEnvVar = 'PRAGMATIC_ADMIN_PORT'
    private static readonly DefaultPort = 7000
    private static readonly EnvPortFloor = 8100
    private static readonly IdpPortFloor = 12100
    private static readonly IdpsFile = 'idps.json'
    private static readonly MaxPort = 65535
    private static readonly BadPortPrefix = 'Invalid PRAGMATIC_ADMIN_PORT: '
    private static readonly BindHost = '127.0.0.1'
    private static readonly DataDir = 'data'
    private static readonly RegistryFile = 'registry.json'
    private static readonly ClientsFile = 'clients.json'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly HivesFile = 'hives.json'
    private static readonly ManifestsFile = 'manifests.json'
    private static readonly GatingFile = 'gating.json'
    private static readonly SelectionsFile = 'selections.json'
    private static readonly ReportsFile = 'rollout-reports.json'
    private static readonly RegistrationsFile = 'rollout-registrations.json'
    private static readonly ParentSegment = '..'
    private static readonly PortalSegment = 'portal'
    private static readonly DistSegment = 'dist'
    private static readonly TenantPortalSegment = 'tenant-portal'
    private static readonly ListeningPrefix = 'Control plane listening on http://localhost:'
    private static readonly ListeningSuffix = '/'
    private static readonly MasterKeyEnvVar = 'PRAGMATIC_ADMIN_MASTER_KEY_FILE'
    private static readonly OperatorEmailEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_EMAIL'
    private static readonly OperatorPasswordEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_PASSWORD'
    private static readonly SecureCookieEnvVar = 'PRAGMATIC_ADMIN_SECURE_COOKIE'
    private static readonly DefaultOperatorEmail = 'admin@control-plane.test'
    private static readonly MasterKeyFileName = 'master.key'
    private static readonly IdentitySegment = 'identity'
    private static readonly TrueToken = 'true'
    private static readonly OneToken = '1'
    private static readonly TenantPortEnvVar = 'PRAGMATIC_TENANT_ADMIN_PORT'
    private static readonly TenantBindEnvVar = 'PRAGMATIC_TENANT_ADMIN_BIND'
    private static readonly TenantBaseDomainEnvVar = 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN'
    private static readonly TenantSchemeEnvVar = 'PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME'
    private static readonly DefaultTenantBind = '127.0.0.1'
    private static readonly DefaultExternalScheme = 'https'
    private static readonly BadTenantPortPrefix = 'Invalid PRAGMATIC_TENANT_ADMIN_PORT: '
    private static readonly TenantListeningPrefix = 'Tenant plane listening on '
    private static readonly SchemeHostSeparator = '://'
    private static readonly HostPortSeparator = ':'
    private static readonly TenantSessionsFile = 'tenant-sessions.json'
    private static readonly TenantSessionTtlMs = 12 * 60 * 60 * 1000
    private static readonly SecretTtlEnvVar = 'PRAGMATIC_TENANT_ADMIN_SECRET_TTL_HOURS'
    private static readonly DefaultSecretTtlHours = 168
    private static readonly MsPerHour = 3600000
    private static readonly HealthProbeMsEnvVar = 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_MS'
    private static readonly DefaultHealthProbeMs = 30000
    private static readonly MinHealthProbeMs = 1000
    private static readonly MaxHealthProbeMs = 2147483647
    private static readonly HealthProbeTimeoutMsEnvVar = 'PRAGMATIC_TENANT_ADMIN_HEALTH_PROBE_TIMEOUT_MS'
    // Above the default probe interval (30s) so a legitimately slow-but-healthy probe is not treated as wedged.
    private static readonly DefaultHealthProbeTimeoutMs = 60000
    private static readonly TenantAdminClientsFile = 'tenant-admin-clients.json'
    private static readonly TenantAdminOidcDir = 'tenant-admin-oidc'
    private static readonly PositiveIntegerPattern = /^[0-9]+$/

    public static async Main(): Promise<void>
    {
        const here = dirname(fileURLToPath(import.meta.url))
        const dataRoot = join(here, ControlPlaneServer.DataDir)
        mkdirSync(dataRoot, { recursive: true })
        const opts = ControlPlaneServer.ReadOperatorOptions(process.env, dataRoot)
        const operator = await OperatorIdentity.Compose(opts)
        const masterKey = MasterKeyFile.Load(opts.masterKeyFile)
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(dataRoot, ControlPlaneServer.RegistryFile), docker)
        await registry.Load()
        await registry.Reconcile()
        const directory = new PlatformDirectory(
            new ClientRegistry(join(dataRoot, ControlPlaneServer.ClientsFile)),
            new TenantRegistry(join(dataRoot, ControlPlaneServer.TenantsFile)),
            new HiveRegistry(join(dataRoot, ControlPlaneServer.HivesFile)),
            registry)
        await directory.Load()
        const allocator = new PortAllocator(ControlPlaneServer.EnvPortFloor, new NetPortProbe())
        const bundle = new BundleBuilderAdapter()
        const seeder = new UserSeederAdapter(new UserSeeder())
        const proxy = new AdminProxy(new WsAdminConnector())
        const idpService = new IdpService(new PortAllocator(ControlPlaneServer.IdpPortFloor, new NetPortProbe()), new IdpContainerEnv(new ExecFileDockerExec()), new IdpRegistry(join(dataRoot, ControlPlaneServer.IdpsFile)), dataRoot, DockerEnv.ImageName)
        const service = new EnvironmentService(registry, allocator, docker, bundle, seeder, dataRoot, proxy, directory, idpService, conn => new IdpAdminClient(conn))
        const graphService = new GraphService(registry, proxy, name => service.AdminInfoFor(name))
        const staticRoot = join(here, ControlPlaneServer.ParentSegment, ControlPlaneServer.PortalSegment, ControlPlaneServer.DistSegment)
        const orchestrators = new HiveOrchestratorFactory()
        const manifests = new ManifestRegistry(join(dataRoot, ControlPlaneServer.ManifestsFile))
        const gating = new GatingRegistry(join(dataRoot, ControlPlaneServer.GatingFile))
        const selections = new SelectionRegistry(join(dataRoot, ControlPlaneServer.SelectionsFile))
        const reports = new RolloutReportRegistry(join(dataRoot, ControlPlaneServer.ReportsFile))
        const registrations = new RolloutRegistrationRegistry(join(dataRoot, ControlPlaneServer.RegistrationsFile))
        const adminClientRegistry = new TenantAdminClientRegistry(join(dataRoot, ControlPlaneServer.TenantAdminClientsFile))
        await Promise.all([manifests.Load(), gating.Load(), selections.Load(), reports.Load(), registrations.Load(), adminClientRegistry.Load()])
        const placement = new EnvironmentPlacement(directory)
        const deployments = new PlatformDeploymentRegistry(manifests, gating, selections, reports, registrations, directory, orchestrators, registry, placement)
        const provisioning = new TenantProvisioningService(idpService, directory, conn => new IdpAdminClient(conn))
        const host = new ControlPlaneHost(service, graphService, staticRoot, operator, opts.secureCookie, directory, orchestrators, deployments, provisioning)
        const port = ControlPlaneServer.ResolvePort(process.env[ControlPlaneServer.PortEnvVar])
        const tenantPlane = ControlPlaneServer.ComposeTenantPlane(process.env, dataRoot, idpService, directory, opts.secureCookie, service, deployments, orchestrators, placement,
            masterKey, adminClientRegistry, ControlPlaneServer.ParseSecretTtlHours(process.env[ControlPlaneServer.SecretTtlEnvVar]))
        // Resolve (and validate) the tenant port + bind BEFORE binding the operator listener, so a misconfigured
        // tenant port fails fast at startup rather than after the operator socket is already live.
        let tenantStart: { host: TenantPlaneHost; port: number; bind: string; scheme: string; baseDomain: string } | undefined
        if (tenantPlane !== undefined)
        {
            const baseDomain = process.env[ControlPlaneServer.TenantBaseDomainEnvVar] as string
            const scheme = ControlPlaneServer.TenantScheme(process.env[ControlPlaneServer.TenantSchemeEnvVar])
            const resolver = new TenantHostResolver(baseDomain, scheme, directory)
            const tenantStaticRoot = join(here, ControlPlaneServer.ParentSegment, ControlPlaneServer.TenantPortalSegment, ControlPlaneServer.DistSegment)
            const probeMs = ControlPlaneServer.ParseHealthProbeMs(process.env[ControlPlaneServer.HealthProbeMsEnvVar])
            const probeTimeoutMs = ControlPlaneServer.ParseHealthProbeTimeoutMs(process.env[ControlPlaneServer.HealthProbeTimeoutMsEnvVar])
            const monitor = probeMs > 0
                ? new TenantHealthMonitor(directory, new HiveHealthProducer(service, orchestrators, placement), tenantPlane.events, probeMs, probeTimeoutMs)
                : undefined
            const tenantHost = new TenantPlaneHost(tenantPlane, resolver, tenantStaticRoot, service, monitor)
            const tenantPort = ControlPlaneServer.ResolveTenantPort(process.env[ControlPlaneServer.TenantPortEnvVar])
            const tenantBind = ControlPlaneServer.TenantBind(process.env[ControlPlaneServer.TenantBindEnvVar])
            tenantStart = { host: tenantHost, port: tenantPort, bind: tenantBind, scheme, baseDomain }
        }
        // The operator listener is structurally loopback-only: no tenant route is mounted on it.
        await host.Listen(port, ControlPlaneServer.BindHost)
        console.log(ControlPlaneServer.ListeningPrefix + String(port) + ControlPlaneServer.ListeningSuffix)
        if (tenantStart !== undefined)
        {
            await tenantStart.host.Listen(tenantStart.port, tenantStart.bind)
            console.log(ControlPlaneServer.TenantListeningPrefix + tenantStart.scheme + ControlPlaneServer.SchemeHostSeparator + tenantStart.baseDomain + ControlPlaneServer.HostPortSeparator + String(tenantStart.port) + ControlPlaneServer.ListeningSuffix)
        }
    }

    /** Pure: derives operator-identity compose options and cookie policy from the environment. */
    public static ReadOperatorOptions(env: NodeJS.ProcessEnv, dataRoot: string): OperatorComposeOptions & { secureCookie: boolean }
    {
        const password = env[ControlPlaneServer.OperatorPasswordEnvVar]
        const secure = env[ControlPlaneServer.SecureCookieEnvVar]
        return {
            masterKeyFile: env[ControlPlaneServer.MasterKeyEnvVar] ?? join(dataRoot, ControlPlaneServer.MasterKeyFileName),
            identityRoot: join(dataRoot, ControlPlaneServer.IdentitySegment),
            operatorEmail: env[ControlPlaneServer.OperatorEmailEnvVar] ?? ControlPlaneServer.DefaultOperatorEmail,
            initialPassword: password === undefined || password === '' ? undefined : password,
            secureCookie: secure === ControlPlaneServer.TrueToken || secure === ControlPlaneServer.OneToken,
        }
    }

    /**
     * Composes the optional tenant plane from the environment. The dedicated tenant listener activates only when
     * both `PRAGMATIC_TENANT_ADMIN_PORT` and `PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN` are present; otherwise the plane
     * is off (fail-closed) and only the operator listener runs, exactly as before. The callback is derived per
     * request from the tenant subdomain host by `TenantPlaneHost`, so no callback is wired here.
     */
    public static ComposeTenantPlane(
        env: NodeJS.ProcessEnv,
        dataRoot: string,
        idpService: IdpService,
        directory: PlatformDirectory,
        secureCookie: boolean,
        service: IEnvironmentService,
        deployments: PlatformDeploymentRegistry,
        orchestrators: HiveOrchestratorFactory,
        placement: EnvironmentPlacement,
        masterKey: Buffer,
        adminClientRegistry: TenantAdminClientRegistry,
        secretTtlHours: number): TenantPlane | undefined
    {
        const port = env[ControlPlaneServer.TenantPortEnvVar]
        const baseDomain = env[ControlPlaneServer.TenantBaseDomainEnvVar]
        if (port === undefined || port === '' || baseDomain === undefined || baseDomain === '')
        {
            return undefined
        }
        const sessions = new TenantSessionStore(join(dataRoot, ControlPlaneServer.TenantSessionsFile), ControlPlaneServer.TenantSessionTtlMs)
        const durability: TenantAdminDurability = {
            storeRoot: join(dataRoot, ControlPlaneServer.TenantAdminOidcDir),
            masterKey,
            registry: adminClientRegistry,
            secretTtlMs: secretTtlHours * ControlPlaneServer.MsPerHour,
        }
        const rp = new TenantOidcRelyingParty(idpService, directory, conn => new IdpAdminClient(conn), undefined, undefined, durability)
        const endpoint = new TenantAuthEndpoint(rp, sessions, secureCookie)
        const gate = new TenantAuthGate(sessions)
        const api = new TenantApiEndpoint(service, directory, deployments, orchestrators, placement)
        const events = new TenantEventBus()
        return { endpoint, gate, api, events, isDurable: rp.IsDurable }
    }

    /** The externally-visible tenant origin scheme; defaults to https when unset or blank. */
    private static TenantScheme(raw: string | undefined): string
    {
        return raw === undefined || raw === '' ? ControlPlaneServer.DefaultExternalScheme : raw
    }

    /** The tenant listener bind address; defaults to loopback (proxy-fronted) when unset or blank. */
    private static TenantBind(raw: string | undefined): string
    {
        return raw === undefined || raw === '' ? ControlPlaneServer.DefaultTenantBind : raw
    }

    /** The dedicated tenant listener port; required (the plane only activates when it is set). */
    private static ResolveTenantPort(raw: string | undefined): number
    {
        const port = Number(raw)
        if (raw === undefined || raw === '' || !Number.isInteger(port) || port < 1 || port > ControlPlaneServer.MaxPort)
        {
            throw new Error(ControlPlaneServer.BadTenantPortPrefix + String(raw))
        }
        return port
    }

    /** Pure: parses the tenant-admin secret TTL in hours; anything but a positive integer yields the default. */
    public static ParseSecretTtlHours(raw: string | undefined): number
    {
        if (raw === undefined || !ControlPlaneServer.PositiveIntegerPattern.test(raw))
        {
            return ControlPlaneServer.DefaultSecretTtlHours
        }
        const hours = Number.parseInt(raw, 10)
        return hours > 0 ? hours : ControlPlaneServer.DefaultSecretTtlHours
    }

    /** Pure: parses the tenant health probe interval in ms; 0 disables, a positive integer within [Min, Max] is honoured, anything else (including out-of-range) yields the default. */
    public static ParseHealthProbeMs(raw: string | undefined): number
    {
        if (raw === undefined || !ControlPlaneServer.PositiveIntegerPattern.test(raw))
        {
            return ControlPlaneServer.DefaultHealthProbeMs
        }
        const ms = Number.parseInt(raw, 10)
        if (ms === 0)
        {
            return 0
        }
        if (ms < ControlPlaneServer.MinHealthProbeMs || ms > ControlPlaneServer.MaxHealthProbeMs)
        {
            return ControlPlaneServer.DefaultHealthProbeMs
        }
        return ms
    }

    /** Pure: parses the per-probe timeout in ms; 0 disables the deadline, a positive integer within [Min, Max] is honoured, anything else yields the default. */
    public static ParseHealthProbeTimeoutMs(raw: string | undefined): number
    {
        if (raw === undefined || !ControlPlaneServer.PositiveIntegerPattern.test(raw))
        {
            return ControlPlaneServer.DefaultHealthProbeTimeoutMs
        }
        const ms = Number.parseInt(raw, 10)
        if (ms === 0)
        {
            return 0
        }
        if (ms < ControlPlaneServer.MinHealthProbeMs || ms > ControlPlaneServer.MaxHealthProbeMs)
        {
            return ControlPlaneServer.DefaultHealthProbeTimeoutMs
        }
        return ms
    }

    private static ResolvePort(raw: string | undefined): number
    {
        if (raw === undefined || raw === '')
        {
            return ControlPlaneServer.DefaultPort
        }
        const port = Number(raw)
        if (!Number.isInteger(port) || port < 1 || port > ControlPlaneServer.MaxPort)
        {
            throw new Error(ControlPlaneServer.BadPortPrefix + raw)
        }
        return port
    }

    /** True when this module is the process entry point (not when imported by tests). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (ControlPlaneServer.IsEntryPoint())
{
    await ControlPlaneServer.Main()
}
