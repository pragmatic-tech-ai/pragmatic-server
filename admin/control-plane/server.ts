import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { ControlPlaneHost } from './control-plane-host.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvironmentService } from './environment-service.js'
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
    private static readonly ParentSegment = '..'
    private static readonly PortalSegment = 'portal'
    private static readonly DistSegment = 'dist'
    private static readonly ListeningPrefix = 'Control plane listening on http://localhost:'
    private static readonly ListeningSuffix = '/'

    public static async Main(): Promise<void>
    {
        const here = dirname(fileURLToPath(import.meta.url))
        const dataRoot = join(here, ControlPlaneServer.DataDir)
        mkdirSync(dataRoot, { recursive: true })
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(dataRoot, ControlPlaneServer.RegistryFile), docker)
        await registry.Load()
        await registry.Reconcile()
        const allocator = new PortAllocator(ControlPlaneServer.EnvPortFloor, new NetPortProbe())
        const bundle = new BundleBuilderAdapter()
        const seeder = new UserSeederAdapter(new UserSeeder())
        const service = new EnvironmentService(registry, allocator, docker, bundle, seeder, dataRoot)
        const staticRoot = join(here, ControlPlaneServer.ParentSegment, ControlPlaneServer.PortalSegment, ControlPlaneServer.DistSegment)
        const host = new ControlPlaneHost(service, staticRoot)
        const port = ControlPlaneServer.ResolvePort(process.env[ControlPlaneServer.PortEnvVar])
        await host.Listen(port, ControlPlaneServer.BindHost)
        console.log(ControlPlaneServer.ListeningPrefix + String(port) + ControlPlaneServer.ListeningSuffix)
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
