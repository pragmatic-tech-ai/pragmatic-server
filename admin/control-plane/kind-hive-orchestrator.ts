import type { EnvironmentWorkload } from './environment-workload.js'
import type { IHiveOrchestrator, WorkloadHealth } from './hive-orchestrator.js'
import type { IKind } from './kind.js'

/** Provisions a kind cluster on demand and delegates workload lifecycle to an inner orchestrator. */
export class KindHiveOrchestrator implements IHiveOrchestrator
{
    private static readonly NotProvisionedDetail = 'cluster not provisioned'

    private ensuring: Promise<void> | undefined

    public constructor(
        private readonly kind: IKind,
        private readonly clusterName: string,
        private readonly inner: IHiveOrchestrator,
    )
    {
    }

    public get ClusterName(): string
    {
        return this.clusterName
    }

    public async Apply(w: EnvironmentWorkload): Promise<void>
    {
        await this.EnsureCluster()
        await this.inner.Apply(w)
    }

    public async WaitHealthy(w: EnvironmentWorkload): Promise<void>
    {
        return this.inner.WaitHealthy(w)
    }

    public async Health(w: EnvironmentWorkload): Promise<WorkloadHealth>
    {
        if (!(await this.ClusterExists()))
        {
            return { ready: false, runningImage: undefined, detail: KindHiveOrchestrator.NotProvisionedDetail }
        }
        return this.inner.Health(w)
    }

    public async Roll(w: EnvironmentWorkload, image: string): Promise<void>
    {
        return this.inner.Roll(w, image)
    }

    /** Namespace-scoped: removes the workload only, never the cluster. */
    public async Teardown(w: EnvironmentWorkload): Promise<void>
    {
        return this.inner.Teardown(w)
    }

    /** Hive-scoped: deletes the whole cluster. Not part of IHiveOrchestrator. */
    public async DestroyCluster(): Promise<void>
    {
        await this.kind.DeleteCluster(this.clusterName)
    }

    private async ClusterExists(): Promise<boolean>
    {
        return (await this.kind.ListClusters()).includes(this.clusterName)
    }

    /** Single in-flight guard: concurrent callers share one create; a failure is not cached. */
    private async EnsureCluster(): Promise<void>
    {
        if (this.ensuring)
        {
            return this.ensuring
        }
        const p = (async () =>
        {
            if (!(await this.ClusterExists()))
            {
                await this.kind.CreateCluster(this.clusterName)
            }
        })()
        this.ensuring = p
        try
        {
            await p
        }
        finally
        {
            this.ensuring = undefined
        }
    }
}
