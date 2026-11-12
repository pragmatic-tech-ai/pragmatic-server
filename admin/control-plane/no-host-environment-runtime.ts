import type { ILogProcess } from '../../environments/seed/docker.js'
import type { EnvDefinition } from '../../environments/seed/bundle.js'
import type { IContainerProbe } from './environment-record.js'
import type { EnvEndpoint, EnvRuntimeContext, IEnvironmentRuntime } from './environment-runtime.js'

/** An unbound (host-run) environment was asked to run where there is no host backend. */
export class HostRuntimeUnavailableError extends Error
{
    private static readonly ErrorName = 'HostRuntimeUnavailableError'
    private static readonly MessagePrefix = 'This tenant admin runs environments only in its own hive; it cannot run the unbound environment '

    public constructor(name: string)
    {
        super(HostRuntimeUnavailableError.MessagePrefix + name)
        this.name = HostRuntimeUnavailableError.ErrorName
    }
}

/**
 * The runtime the in-hive tenant admin resolves for an unbound environment: it has no host (Docker) backend, so nothing
 * unbound ever runs here. It reports such an environment as not running, lets stop / teardown pass (there is nothing to
 * stop), and refuses every verb that would bring one up or read its output with a HostRuntimeUnavailableError. The tenant
 * API only creates hive-bound environments, so this is reached only by an unbound record already in the data root.
 */
export class NoHostEnvironmentRuntime implements IEnvironmentRuntime, IContainerProbe
{
    private static readonly NoHostName = '(no host backend)'

    public PublishesHostPort(): boolean
    {
        return false
    }

    public EnsureImage(def: EnvDefinition): Promise<boolean>
    {
        return Promise.reject(new HostRuntimeUnavailableError(def.name))
    }

    public BuildCommand(): string
    {
        throw new HostRuntimeUnavailableError(NoHostEnvironmentRuntime.NoHostName)
    }

    public Prepare(ctx: EnvRuntimeContext): Promise<void>
    {
        return NoHostEnvironmentRuntime.Refuse(ctx)
    }

    public BringUp(ctx: EnvRuntimeContext): Promise<EnvEndpoint>
    {
        return NoHostEnvironmentRuntime.Refuse(ctx)
    }

    public WaitHealthy(ctx: EnvRuntimeContext): Promise<void>
    {
        return NoHostEnvironmentRuntime.Refuse(ctx)
    }

    public Start(ctx: EnvRuntimeContext): Promise<EnvEndpoint>
    {
        return NoHostEnvironmentRuntime.Refuse(ctx)
    }

    public async Stop(_ctx: EnvRuntimeContext): Promise<void>
    {
    }

    public async Teardown(_ctx: EnvRuntimeContext, _removeData: boolean): Promise<void>
    {
    }

    public async RemoveVolume(_ctx: EnvRuntimeContext): Promise<void>
    {
    }

    public Logs(ctx: EnvRuntimeContext): Promise<string>
    {
        return NoHostEnvironmentRuntime.Refuse(ctx)
    }

    public LogStream(ctx: EnvRuntimeContext, _onData: (chunk: string) => void): ILogProcess
    {
        throw new HostRuntimeUnavailableError(ctx.record.name)
    }

    public async Probe(_ctx: EnvRuntimeContext): Promise<boolean>
    {
        return false
    }

    public async Running(_containerName: string): Promise<boolean>
    {
        return false
    }

    private static Refuse<T>(ctx: EnvRuntimeContext): Promise<T>
    {
        return Promise.reject(new HostRuntimeUnavailableError(ctx.record.name))
    }
}
