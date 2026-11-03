import type { IBundleBuilder } from './docker-env-port.js'
import { EnvServerSeedSource } from './env-server-seed.js'
import type { EnvDefinition } from '../../environments/seed/bundle.js'
import type { ILogProcess } from '../../environments/seed/docker.js'
import type { EnvEndpoint, EnvRuntimeContext, IEnvironmentRuntime } from './environment-runtime.js'
import type { EnvironmentPlacement } from './environment-placement.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import type { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { ImageVerificationError } from './image-verifier.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { ITenantDirectory } from './tenant-api/tenant-directory.js'

/**
 * Raised for any orchestrator failure. The message carries no kubectl stderr, manifest or secret content: only, for a
 * failure known to be safe to show (an image the hive refused to run), a plain Reason. Detail is the underlying error's
 * text with the environment's OIDC secret redacted; it is for the operator's log, never for a response body.
 */
export class InClusterOperationFailedError extends Error
{
    private static readonly DefaultMessage = 'In-cluster environment operation failed.'
    private static readonly ErrorName = 'InClusterOperationFailedError'
    private static readonly Space = ' '

    public constructor(public readonly Reason?: string, public readonly Detail?: string)
    {
        super(Reason === undefined ? InClusterOperationFailedError.DefaultMessage : InClusterOperationFailedError.DefaultMessage + InClusterOperationFailedError.Space + Reason)
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

/** A hive-bound record whose hive is not in the directory. */
export class InClusterBundleMissingError extends Error
{
    private static readonly DefaultMessage = 'The boot bundle for this in-cluster environment is not available; it must be prepared before bring-up.'
    private static readonly ErrorName = 'InClusterBundleMissingError'

    public constructor()
    {
        super(InClusterBundleMissingError.DefaultMessage)
        this.name = InClusterBundleMissingError.ErrorName
    }
}

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
    private static readonly StoppedReplicas = 0
    private static readonly StartedReplicas = 1
    private static readonly RefusedImagePrefix = 'The hive refused to run image '
    private static readonly RefusedImageOpen = ' ('
    private static readonly RefusedImageClose = ').'
    private static readonly Redacted = '[redacted]'

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
        const bundleDir = ctx.bundleDir
        if (bundleDir === undefined)
        {
            throw new InClusterBundleMissingError()
        }
        await InClusterEnvironmentRuntime.Guard(ctx, async () =>
        {
            await orchestrator.Apply(workload)
            if (workload.federation !== undefined && ctx.caPem !== undefined)
            {
                // ca.crt-only trust Secret. Applied after Apply creates the namespace; the pod's CA volume mount
                // is retried by kubelet until this Secret exists, so landing it after the Deployment is safe.
                await EnvServerSeedSource.ApplyIdpCa(orchestrator.Kubectl, ctx.record.name, ctx.caPem)
            }
            await EnvServerSeedSource.ApplyBundle(orchestrator.Kubectl, bundleDir, ctx.record.name, ctx.def.environmentId, workload.database?.passwordRef)
        })
        return InClusterEnvironmentRuntime.EndpointOf(ctx, workload)
    }

    public async WaitHealthy(ctx: EnvRuntimeContext): Promise<void>
    {
        const { orchestrator, workload } = this.Resolve(ctx)
        await InClusterEnvironmentRuntime.Guard(ctx, () => orchestrator.WaitHealthy(workload))
    }

    public async Start(ctx: EnvRuntimeContext): Promise<EnvEndpoint>
    {
        // Readiness-first: the DB StatefulSet is brought up and awaited BEFORE the server is applied/scaled, so the
        // server never starts against an unready database. DB-less envs skip this entirely.
        const { orchestrator, workload } = this.Resolve(ctx)
        if (workload.database !== undefined)
        {
            await InClusterEnvironmentRuntime.Guard(ctx, () => orchestrator.ScaleDatabase(workload, InClusterEnvironmentRuntime.StartedReplicas))
        }
        const endpoint = await this.BringUp(ctx)
        await this.WaitHealthy(ctx)
        return endpoint
    }

    /** Scale-to-zero only (server Deployment, then the DB StatefulSet when present): the namespace, PVC and Secrets are retained so Start can bring the same data back. NEVER Teardown. */
    public async Stop(ctx: EnvRuntimeContext): Promise<void>
    {
        const { orchestrator, workload } = this.Resolve(ctx)
        await InClusterEnvironmentRuntime.Guard(ctx, () => orchestrator.Scale(workload, InClusterEnvironmentRuntime.StoppedReplicas))
        if (workload.database !== undefined)
        {
            await InClusterEnvironmentRuntime.Guard(ctx, () => orchestrator.ScaleDatabase(workload, InClusterEnvironmentRuntime.StoppedReplicas))
        }
    }

    public async Teardown(ctx: EnvRuntimeContext, _removeData: boolean): Promise<void>
    {
        const { orchestrator, workload } = this.Resolve(ctx)
        await InClusterEnvironmentRuntime.Guard(ctx, () => orchestrator.Teardown(workload))
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
        const health = await InClusterEnvironmentRuntime.Guard(ctx, () => orchestrator.Health(workload))
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

    private static async Guard<T>(ctx: EnvRuntimeContext, op: () => Promise<T>): Promise<T>
    {
        try
        {
            return await op()
        }
        catch (err)
        {
            throw new InClusterOperationFailedError(InClusterEnvironmentRuntime.ShowableReason(err), InClusterEnvironmentRuntime.RedactedDetail(err, ctx))
        }
    }

    // Only failures whose text is known to be safe get a reason a tenant may see; an image verification error names the
    // image ref and why it was refused, never signature, digest or key material.
    private static ShowableReason(err: unknown): string | undefined
    {
        if (err instanceof ImageVerificationError)
        {
            const C = InClusterEnvironmentRuntime
            return C.RefusedImagePrefix + err.ImageRef + C.RefusedImageOpen + err.Reason + C.RefusedImageClose
        }
        return undefined
    }

    private static RedactedDetail(err: unknown, ctx: EnvRuntimeContext): string
    {
        const message = err instanceof Error ? err.message : String(err)
        const secret = ctx.oidc?.secret
        return secret === undefined || secret === '' ? message : message.split(secret).join(InClusterEnvironmentRuntime.Redacted)
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
