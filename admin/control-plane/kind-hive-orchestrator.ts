import type { EnvironmentWorkload } from './environment-workload.js'
import type { IHiveOrchestrator, WorkloadHealth } from './hive-orchestrator.js'
import type { IKind } from './kind.js'
import type { IKubectl } from './kubectl.js'

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

    public get Kubectl(): IKubectl
    {
        return this.inner.Kubectl
    }

    public get ClusterName(): string
    {
        return this.clusterName
    }

    public async Apply(w: EnvironmentWorkload): Promise<void>
    {
        await this.EnsureCluster()
        // Best-effort: load a locally built image into the node so kind can run it without a registry (repeatable,
        // so re-Apply is safe). A registry-only image has no local copy to load; the node pulls it instead, so a
        // load failure must not gate Apply - the workload's real reachability surfaces through Health.
        await this.LoadImageBestEffort(w.image)
        await this.inner.Apply(w)
    }

    private async LoadImageBestEffort(image: string): Promise<void>
    {
        try
        {
            await this.kind.LoadImage(image, this.clusterName)
        }
        catch
        {
            // Distribution is an optimization for locally built images, not a gate: a registry-backed image is
            // pulled by the node, and an unreachable image fails observably at Health rather than silently here.
        }
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

    public async Scale(workload: EnvironmentWorkload, replicas: number): Promise<void>
    {
        return this.inner.Scale(workload, replicas)
    }

    public async ScaleDatabase(workload: EnvironmentWorkload, replicas: number): Promise<void>
    {
        return this.inner.ScaleDatabase(workload, replicas)
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
