import type { EnvDefinition, EnvOidc } from '../../environments/seed/bundle.js'
import type { ILogProcess } from '../../environments/seed/docker.js'
import type { EnvironmentRecord } from './environment-record.js'
import type { IBundleBuilder, IDockerEnv } from './docker-env-port.js'

/** Where a brought-up environment is reachable. hostPort is set only by backends that publish a host port. */
export type EnvEndpoint = { httpUrl: string; wsUrl: string; hostPort?: number }

/** Everything a runtime backend needs to act on one environment. seedDir feeds Prepare only. */
export type EnvRuntimeContext = { def: EnvDefinition; record: EnvironmentRecord; bundleDir?: string; seedDir?: string; oidc?: EnvOidc; caHostPath?: string }

/** The backend-shaped lifecycle operations of an environment (Docker today); EnvironmentService orchestrates over this seam. */
export interface IEnvironmentRuntime
{
    EnsureImage(def: EnvDefinition): Promise<boolean>
    BuildCommand(): string
    /** Materialises the environment's deployment artefacts (the Docker bundle) before the image check; runs ahead of EnsureImage so a failure leaves no Failed record. */
    Prepare(ctx: EnvRuntimeContext): Promise<void>
    BringUp(ctx: EnvRuntimeContext): Promise<EnvEndpoint>
    WaitHealthy(ctx: EnvRuntimeContext): Promise<void>
    Start(ctx: EnvRuntimeContext): Promise<EnvEndpoint>
    Stop(ctx: EnvRuntimeContext): Promise<void>
    Teardown(ctx: EnvRuntimeContext, removeData: boolean): Promise<void>
    RemoveVolume(ctx: EnvRuntimeContext): Promise<void>
    Logs(ctx: EnvRuntimeContext): Promise<string>
    LogStream(ctx: EnvRuntimeContext, onData: (chunk: string) => void): ILogProcess
    Probe(ctx: EnvRuntimeContext): Promise<boolean>
}

/** The one home for the localhost connect URLs of a host-port-published environment; shared by the Docker runtime and the DTO mapper. */
export class LocalhostUrls
{
    private static readonly HttpPrefix = 'http://localhost:'
    private static readonly WsPrefix = 'ws://localhost:'
    private static readonly EnvironmentQuery = '/?environment='

    public static Http(port: number): string
    {
        return LocalhostUrls.HttpPrefix + String(port)
    }

    public static Ws(port: number, environmentId: string): string
    {
        return LocalhostUrls.WsPrefix + String(port) + LocalhostUrls.EnvironmentQuery + environmentId
    }
}

/** The Docker backend: forwards each operation to the existing IDockerEnv / IBundleBuilder exactly as EnvironmentService did before the seam. */
export class DockerEnvironmentRuntime implements IEnvironmentRuntime
{
    private static readonly NoContainerName = ''
    private static readonly NoHostPort = 'docker environment has no host port: '

    public constructor(
        private readonly docker: IDockerEnv,
        private readonly bundle: IBundleBuilder)
    {
    }

    public EnsureImage(_def: EnvDefinition): Promise<boolean>
    {
        return this.docker.EnsureImage()
    }

    public BuildCommand(): string
    {
        return this.docker.BuildCommand()
    }

    public async Prepare(ctx: EnvRuntimeContext): Promise<void>
    {
        await this.bundle.Generate(ctx.def, DockerEnvironmentRuntime.BundleDirOf(ctx), ctx.seedDir, ctx.oidc)
    }

    public async BringUp(ctx: EnvRuntimeContext): Promise<EnvEndpoint>
    {
        await this.docker.Up(ctx.def, DockerEnvironmentRuntime.BundleDirOf(ctx), ctx.caHostPath)
        return DockerEnvironmentRuntime.EndpointOf(ctx)
    }

    public WaitHealthy(ctx: EnvRuntimeContext): Promise<void>
    {
        return this.docker.WaitHealthy(DockerEnvironmentRuntime.PortOf(ctx), ctx.def)
    }

    public async Start(ctx: EnvRuntimeContext): Promise<EnvEndpoint>
    {
        await this.docker.Up(ctx.def, ctx.record.bundleDir as string)
        await this.WaitHealthy(ctx)
        return DockerEnvironmentRuntime.EndpointOf(ctx)
    }

    public Stop(ctx: EnvRuntimeContext): Promise<void>
    {
        return this.docker.Down(ctx.def)
    }

    public Teardown(ctx: EnvRuntimeContext, removeData: boolean): Promise<void>
    {
        return this.docker.Down(ctx.def, removeData)
    }

    public RemoveVolume(ctx: EnvRuntimeContext): Promise<void>
    {
        return this.docker.RemoveVolume(ctx.def)
    }

    public Logs(ctx: EnvRuntimeContext): Promise<string>
    {
        return this.docker.Logs(ctx.def)
    }

    public LogStream(ctx: EnvRuntimeContext, onData: (chunk: string) => void): ILogProcess
    {
        return this.docker.LogStream(ctx.def, onData)
    }

    public Probe(ctx: EnvRuntimeContext): Promise<boolean>
    {
        return this.docker.Running(ctx.record.containerName ?? DockerEnvironmentRuntime.NoContainerName)
    }

    private static BundleDirOf(ctx: EnvRuntimeContext): string
    {
        return ctx.bundleDir as string
    }

    private static PortOf(ctx: EnvRuntimeContext): number
    {
        const port = ctx.record.hostPort
        if (port === undefined)
        {
            throw new Error(DockerEnvironmentRuntime.NoHostPort + ctx.record.name)
        }
        return port
    }

    private static EndpointOf(ctx: EnvRuntimeContext): EnvEndpoint
    {
        const port = DockerEnvironmentRuntime.PortOf(ctx)
        return {
            httpUrl: LocalhostUrls.Http(port),
            wsUrl: LocalhostUrls.Ws(port, ctx.def.environmentId),
            hostPort: port
        }
    }
}
