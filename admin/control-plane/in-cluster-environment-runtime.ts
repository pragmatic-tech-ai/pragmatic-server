import type { IBundleBuilder } from './docker-env-port.js'
import { EnvServerSeedSource } from './env-server-seed.js'
import type { EnvDefinition } from '../../environments/seed/bundle.js'
import type { ILogProcess } from '../../environments/seed/docker.js'
import type { EnvEndpoint, EnvRuntimeContext, IEnvironmentRuntime } from './environment-runtime.js'
import type { EnvironmentPlacement } from './environment-placement.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import type { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { ITenantDirectory } from './tenant-api/tenant-directory.js'

/** Raised for any orchestrator failure; deliberately carries no kubectl stderr, manifest or secret content. */
export class InClusterOperationFailedError extends Error
{
    private static readonly DefaultMessage = 'In-cluster environment operation failed.'
    private static readonly ErrorName = 'InClusterOperationFailedError'

    public constructor()
    {
        super(InClusterOperationFailedError.DefaultMessage)
        this.name = InClusterOperationFailedError.ErrorName
    }
}

/** In-cluster environments have no log access yet; a deferred concern. */
export class EnvLogsUnavailableInClusterError extends Error
{
    private static readonly DefaultMessage = 'Logs are not available for in-cluster environments.'
    private static readonly ErrorName = 'EnvLogsUnavailableInClusterError'

    public constructor()
    {
        super(EnvLogsUnavailableInClusterError.DefaultMessage)
        this.name = EnvLogsUnavailableInClusterError.ErrorName
    }
}

/** The orchestrator offers no stop distinct from teardown, so an in-cluster environment cannot be stopped. */
export class EnvStopUnavailableInClusterError extends Error
{
    private static readonly DefaultMessage = 'Stopping is not available for in-cluster environments; delete the environment instead.'
    private static readonly ErrorName = 'EnvStopUnavailableInClusterError'

    public constructor()
    {
        super(EnvStopUnavailableInClusterError.DefaultMessage)
        this.name = EnvStopUnavailableInClusterError.ErrorName
    }
}

/** A hive-bound record whose hive is not in the directory. */
export class InClusterHiveMissingError extends Error
{
    private static readonly DefaultMessage = 'The hive for this environment was not found.'
    private static readonly ErrorName = 'InClusterHiveMissingError'

    public constructor()
    {
        super(InClusterHiveMissingError.DefaultMessage)
        this.name = InClusterHiveMissingError.ErrorName
    }
}

/** The in-cluster backend: drives the hive orchestrator with the placement workload; no host bundle, no host port. */
export class InClusterEnvironmentRuntime implements IEnvironmentRuntime
{
    private static readonly BuildCommandText = 'in-cluster environments use the hive registry image; no local build step'
    private static readonly HttpScheme = 'http://'
    private static readonly WsScheme = 'ws://'
    private static readonly ClusterDomain = '.svc.cluster.local'
    private static readonly Dot = '.'
    private static readonly PortSeparator = ':'
    private static readonly EnvironmentQuery = '/?environment='
    private static readonly ListApiVersion = 'v1'
    private static readonly ListKind = 'List'

    public constructor(
        private readonly orchestrators: HiveOrchestratorFactory,
        private readonly placement: EnvironmentPlacement,
        private readonly directory: ITenantDirectory,
        private readonly bundle: IBundleBuilder)
    {
    }

    public PublishesHostPort(): boolean
    {
        return false
    }

    public EnsureImage(_def: EnvDefinition): Promise<boolean>
    {
        return Promise.resolve(true)
    }

    public BuildCommand(): string
    {
        return InClusterEnvironmentRuntime.BuildCommandText
    }

    public async Prepare(ctx: EnvRuntimeContext): Promise<void>
    {
        if (ctx.bundleDir !== undefined)
        {
            await this.bundle.Generate(ctx.def, ctx.bundleDir, ctx.seedDir, ctx.oidc)
        }
    }

    public async BringUp(ctx: EnvRuntimeContext): Promise<EnvEndpoint>
    {
        const { orchestrator, workload } = this.Resolve(ctx)
        await InClusterEnvironmentRuntime.Guard(async () =>
        {
            await orchestrator.Apply(workload)
            const seed = new EnvServerSeedSource(ctx.bundleDir!, ctx.record.name, workload.database?.passwordRef)
            const list = {
                apiVersion: InClusterEnvironmentRuntime.ListApiVersion,
                kind: InClusterEnvironmentRuntime.ListKind,
                items: [seed.ConfigMapManifest(), ...seed.SecretSet().RenderManifest()]
            }
            await orchestrator.Kubectl.Apply(JSON.stringify(list))
        })
        return InClusterEnvironmentRuntime.EndpointOf(ctx, workload)
    }

    public async WaitHealthy(ctx: EnvRuntimeContext): Promise<void>
    {
        const { orchestrator, workload } = this.Resolve(ctx)
        await InClusterEnvironmentRuntime.Guard(() => orchestrator.WaitHealthy(workload))
    }

    public async Start(ctx: EnvRuntimeContext): Promise<EnvEndpoint>
    {
        const endpoint = await this.BringUp(ctx)
        await this.WaitHealthy(ctx)
        return endpoint
    }

    public Stop(_ctx: EnvRuntimeContext): Promise<void>
    {
        return Promise.reject(new EnvStopUnavailableInClusterError())
    }

    public async Teardown(ctx: EnvRuntimeContext, _removeData: boolean): Promise<void>
    {
        const { orchestrator, workload } = this.Resolve(ctx)
        await InClusterEnvironmentRuntime.Guard(() => orchestrator.Teardown(workload))
    }

    public RemoveVolume(_ctx: EnvRuntimeContext): Promise<void>
    {
        return Promise.resolve()
    }

    public Logs(_ctx: EnvRuntimeContext): Promise<string>
    {
        return Promise.reject(new EnvLogsUnavailableInClusterError())
    }

    public LogStream(_ctx: EnvRuntimeContext, _onData: (chunk: string) => void): ILogProcess
    {
        throw new EnvLogsUnavailableInClusterError()
    }

    public async Probe(ctx: EnvRuntimeContext): Promise<boolean>
    {
        const { orchestrator, workload } = this.Resolve(ctx)
        const health = await InClusterEnvironmentRuntime.Guard(() => orchestrator.Health(workload))
        return health.ready
    }

    private Resolve(ctx: EnvRuntimeContext): { orchestrator: IHiveOrchestrator; workload: EnvironmentWorkload }
    {
        const hive = ctx.record.hiveId === undefined ? undefined : this.directory.GetHive(ctx.record.hiveId)
        if (hive === undefined)
        {
            throw new InClusterHiveMissingError()
        }
        const workload = this.placement.WorkloadFor(ctx.record)
        return { orchestrator: this.orchestrators.For(hive), workload }
    }

    private static async Guard<T>(op: () => Promise<T>): Promise<T>
    {
        try
        {
            return await op()
        }
        catch
        {
            throw new InClusterOperationFailedError()
        }
    }

    private static EndpointOf(ctx: EnvRuntimeContext, workload: EnvironmentWorkload): EnvEndpoint
    {
        const host = K8sManifestBuilder.ServerDeploymentOf(workload.environmentName)
            + InClusterEnvironmentRuntime.Dot + K8sManifestBuilder.NamespaceOf(workload.environmentName)
            + InClusterEnvironmentRuntime.ClusterDomain
            + InClusterEnvironmentRuntime.PortSeparator + String(workload.serverPort)
        return {
            httpUrl: InClusterEnvironmentRuntime.HttpScheme + host,
            wsUrl: InClusterEnvironmentRuntime.WsScheme + host + InClusterEnvironmentRuntime.EnvironmentQuery + ctx.def.environmentId
        }
    }
}
