import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { ControlPlaneHost } from './control-plane-host.js'
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

export class ControlPlaneServer
{
    private static readonly PortEnvVar = 'PRAGMATIC_ADMIN_PORT'
    private static readonly DefaultPort = 7000
    private static readonly EnvPortFloor = 8100
    private static readonly MaxPort = 65535
    private static readonly BadPortPrefix = 'Invalid PRAGMATIC_ADMIN_PORT: '
    private static readonly BindHost = '127.0.0.1'
    private static readonly DataDir = 'data'
    private static readonly RegistryFile = 'registry.json'
    private static readonly ClientsFile = 'clients.json'
    private static readonly TenantsFile = 'tenants.json'
    private static readonly HivesFile = 'hives.json'
    private static readonly ParentSegment = '..'
    private static readonly PortalSegment = 'portal'
    private static readonly DistSegment = 'dist'
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

    public static async Main(): Promise<void>
    {
        const here = dirname(fileURLToPath(import.meta.url))
        const dataRoot = join(here, ControlPlaneServer.DataDir)
        mkdirSync(dataRoot, { recursive: true })
        const opts = ControlPlaneServer.ReadOperatorOptions(process.env, dataRoot)
        const operator = await OperatorIdentity.Compose(opts)
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
        const service = new EnvironmentService(registry, allocator, docker, bundle, seeder, dataRoot, proxy)
        const graphService = new GraphService(registry, proxy, name => service.AdminInfoFor(name))
        const staticRoot = join(here, ControlPlaneServer.ParentSegment, ControlPlaneServer.PortalSegment, ControlPlaneServer.DistSegment)
        const host = new ControlPlaneHost(service, graphService, staticRoot, operator, opts.secureCookie, directory)
        const port = ControlPlaneServer.ResolvePort(process.env[ControlPlaneServer.PortEnvVar])
        await host.Listen(port, ControlPlaneServer.BindHost)
        console.log(ControlPlaneServer.ListeningPrefix + String(port) + ControlPlaneServer.ListeningSuffix)
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
