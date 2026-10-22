import type { EnvironmentWorkload } from './environment-workload.js'
import type { IHiveOrchestrator, WorkloadHealth } from './hive-orchestrator.js'
import type { IKubectl } from './kubectl.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { EffectiveRegistry } from './effective-registry.js'
import type { IImageVerifier } from './image-verifier.js'

export type OrchestratorPolling = { attempts: number; intervalMs: number }

/** Drives a workload on a cluster through kubectl. Teardown removes only the environment namespace. */
export class KubectlHiveOrchestrator implements IHiveOrchestrator
{
    public static readonly DefaultPolling: OrchestratorPolling = { attempts: 60, intervalMs: 2000 }

    private static readonly DeploymentPrefix = 'deployment/'
    private static readonly StatefulSetPrefix = 'statefulset/'
    private static readonly StatusKey = 'status'
    private static readonly ReadyReplicasKey = 'readyReplicas'
    private static readonly SpecKey = 'spec'
    private static readonly TemplateKey = 'template'
    private static readonly ContainersKey = 'containers'
    private static readonly NameKey = 'name'
    private static readonly ImageKey = 'image'
    private static readonly DetailReady = 'ready replicas: '
    private static readonly DetailImage = '; image: '
    private static readonly DetailNoImage = 'unknown'
    private static readonly DatabaseNotReady = 'database not ready: '
    private static readonly MinReady = 1

    public get Kubectl(): IKubectl
    {
        return this.kubectl
    }

    public get Registry(): EffectiveRegistry
    {
        return this.registry
    }

    public constructor(
        private readonly kubectl: IKubectl,
        private readonly manifests: K8sManifestBuilder,
        private readonly registry: EffectiveRegistry,
        private readonly verifier: IImageVerifier,
        private readonly trustRootRef: string | undefined,
        private readonly polling: OrchestratorPolling = KubectlHiveOrchestrator.DefaultPolling)
    {
    }

    public async Apply(w: EnvironmentWorkload): Promise<void>
    {
        const image = await this.VerifiedImage(w.image)
        await this.kubectl.Apply(this.manifests.Render({ ...w, image }))
    }

    public async WaitHealthy(w: EnvironmentWorkload): Promise<void>
    {
        const ns = K8sManifestBuilder.NamespaceOf(w.environmentName)
        await this.kubectl.RolloutStatus(ns, K8sManifestBuilder.ServerDeploymentOf(w.environmentName))
        if (w.database)
        {
            await this.WaitDatabase(ns, K8sManifestBuilder.DatabaseOf(w.environmentName))
        }
    }

    public async Health(w: EnvironmentWorkload): Promise<WorkloadHealth>
    {
        const ns = K8sManifestBuilder.NamespaceOf(w.environmentName)
        const resource = KubectlHiveOrchestrator.DeploymentPrefix + K8sManifestBuilder.ServerDeploymentOf(w.environmentName)
        const doc = JSON.parse(await this.kubectl.Get(ns, resource))
        const readyReplicas = KubectlHiveOrchestrator.ReadyCount(doc)
        const runningImage = KubectlHiveOrchestrator.ServerImage(doc)
        return {
            ready: readyReplicas >= KubectlHiveOrchestrator.MinReady,
            runningImage,
            detail: KubectlHiveOrchestrator.DetailReady + readyReplicas + KubectlHiveOrchestrator.DetailImage + (runningImage ?? KubectlHiveOrchestrator.DetailNoImage),
        }
    }

    public async Roll(w: EnvironmentWorkload, image: string): Promise<void>
    {
        const ns = K8sManifestBuilder.NamespaceOf(w.environmentName)
        const deployment = K8sManifestBuilder.ServerDeploymentOf(w.environmentName)
        const verified = await this.VerifiedImage(image)
        await this.kubectl.SetImage(ns, deployment, K8sManifestBuilder.ServerContainerName, verified)
        await this.kubectl.RolloutStatus(ns, deployment)
    }

    public Teardown(w: EnvironmentWorkload): Promise<void>
    {
        return this.kubectl.DeleteNamespace(K8sManifestBuilder.NamespaceOf(w.environmentName))
    }

    /** Rewrites to the effective registry and verifies the signature; a rejection propagates so the cluster is never touched. */
    private async VerifiedImage(baseImage: string): Promise<string>
    {
        const img = this.registry.ImageRef(baseImage)
        await this.verifier.Verify(img, this.trustRootRef)
        return img
    }

    /** IKubectl.RolloutStatus is deployment-only, so the StatefulSet is polled via Get until a replica is ready. */
    private async WaitDatabase(ns: string, statefulSet: string): Promise<void>
    {
        for (let attempt = 0; attempt < this.polling.attempts; attempt++)
        {
            const doc = JSON.parse(await this.kubectl.Get(ns, KubectlHiveOrchestrator.StatefulSetPrefix + statefulSet))
            if (KubectlHiveOrchestrator.ReadyCount(doc) >= KubectlHiveOrchestrator.MinReady)
            {
                return
            }
            await new Promise(resolve => setTimeout(resolve, this.polling.intervalMs))
        }
        throw new Error(KubectlHiveOrchestrator.DatabaseNotReady + statefulSet)
    }

    private static ReadyCount(doc: any): number
    {
        const n = doc?.[KubectlHiveOrchestrator.StatusKey]?.[KubectlHiveOrchestrator.ReadyReplicasKey]
        return typeof n === 'number' ? n : 0
    }

    private static ServerImage(doc: any): string | undefined
    {
        const spec = KubectlHiveOrchestrator.SpecKey
        const containers: any[] = doc?.[spec]?.[KubectlHiveOrchestrator.TemplateKey]?.[spec]?.[KubectlHiveOrchestrator.ContainersKey] ?? []
        const server = containers.find(c => c?.[KubectlHiveOrchestrator.NameKey] === K8sManifestBuilder.ServerContainerName)
        const image = server?.[KubectlHiveOrchestrator.ImageKey]
        return typeof image === 'string' ? image : undefined
    }
}
