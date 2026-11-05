import { KubectlError, NamespaceSweep, type IKubectl } from './kubectl.js'
import { KubeApiClient, KubeApiError, KubeContentType, KubeMethod, KubeResourceCatalog, type KubeTypeRef } from './kube-api-client.js'
import { SystemInstallClock, type IInstallClock } from './hive-agent-installer.js'
import type { OrchestratorPolling } from './kubectl-hive-orchestrator.js'

export class RolloutTimeoutError extends KubectlError
{
    private static readonly RolloutPrefix = 'Deployment '
    private static readonly RolloutSuffix = ' did not finish rolling out in time.'
    private static readonly RolloutErrorName = 'RolloutTimeoutError'

    public constructor(namespace: string, deployment: string)
    {
        super(RolloutTimeoutError.RolloutPrefix + namespace + '/' + deployment + RolloutTimeoutError.RolloutSuffix, '', false)
        this.name = RolloutTimeoutError.RolloutErrorName
    }
}

/** A namespace or other resource that was deleted but still exists after the bounded wait. */
export class DeleteTimeoutError extends KubectlError
{
    private static readonly DeletePrefix = 'Resource '
    private static readonly DeleteSuffix = ' was not deleted in time.'
    private static readonly DeleteErrorName = 'DeleteTimeoutError'

    public constructor(resource: string)
    {
        super(DeleteTimeoutError.DeletePrefix + resource + DeleteTimeoutError.DeleteSuffix, '', false)
        this.name = DeleteTimeoutError.DeleteErrorName
    }
}

type ManifestObject = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string } }

type DeploymentState = {
    metadata?: { generation?: number }
    spec?: { replicas?: number }
    status?: { observedGeneration?: number; replicas?: number; updatedReplicas?: number; availableReplicas?: number }
}

/** IKubectl over the Kubernetes API: the in-cluster replacement for the kubectl binary. */
export class ApiKubectl implements IKubectl
{
    public static readonly DefaultRollout: OrchestratorPolling = { attempts: 150, intervalMs: 2000 }
    private static readonly BadManifestMessage = 'kubectl manifest was not valid JSON'
    private static readonly MissingNamespacePrefix = 'Namespaced object has no metadata.namespace: '
    private static readonly ScaleSegment = '/scale'
    private static readonly RestartedAt = 'kubectl.kubernetes.io/restartedAt'
    private static readonly DeploymentType: KubeTypeRef = { apiVersion: 'apps/v1', kind: 'Deployment' }
    private static readonly StatefulSetType: KubeTypeRef = { apiVersion: 'apps/v1', kind: 'StatefulSet' }
    private static readonly NotFound = 404
    private static readonly Comma = ','
    private static readonly Slash = '/'
    private static readonly NamespaceLabel = 'namespace/'
    private static readonly DefaultReplicas = 1

    public constructor(
        private readonly client: KubeApiClient,
        private readonly clock: IInstallClock = new SystemInstallClock(),
        private readonly rollout: OrchestratorPolling = ApiKubectl.DefaultRollout)
    {
    }

    public get Client(): KubeApiClient
    {
        return this.client
    }

    public async Apply(manifestJson: string): Promise<void>
    {
        for (const item of ApiKubectl.ItemsOf(manifestJson))
        {
            await this.client.Apply(ApiKubectl.PathOfObject(item), item)
        }
    }

    public ApplyServerSide(manifestJson: string): Promise<void>
    {
        return this.Apply(manifestJson)
    }

    public async Get(namespace: string, resource: string): Promise<string>
    {
        const path = ApiKubectl.PathOfResource(namespace, resource)
        const found = await this.client.Get(path)
        if (found === undefined)
        {
            throw new KubeApiError(ApiKubectl.NotFound, KubeMethod.Get, path, undefined)
        }
        return JSON.stringify(found)
    }

    public async Find(namespace: string, resource: string): Promise<string | undefined>
    {
        const found = await this.client.Get(ApiKubectl.PathOfResource(namespace, resource))
        return found === undefined ? undefined : JSON.stringify(found)
    }

    public SetImage(namespace: string, deployment: string, container: string, image: string): Promise<void>
    {
        const body = { spec: { template: { spec: { containers: [{ name: container, image }] } } } }
        return this.client.Patch(ApiKubectl.DeploymentPath(namespace, deployment), body, KubeContentType.StrategicMerge)
    }

    public Scale(namespace: string, deployment: string, replicas: number): Promise<void>
    {
        return this.client.Patch(ApiKubectl.DeploymentPath(namespace, deployment) + ApiKubectl.ScaleSegment, { spec: { replicas } }, KubeContentType.MergePatch)
    }

    public ScaleStatefulSet(namespace: string, statefulSet: string, replicas: number): Promise<void>
    {
        const path = KubeResourceCatalog.PathOf(ApiKubectl.StatefulSetType, namespace, statefulSet)
        return this.client.Patch(path + ApiKubectl.ScaleSegment, { spec: { replicas } }, KubeContentType.MergePatch)
    }

    public RolloutRestart(namespace: string, deployment: string): Promise<void>
    {
        const annotations = { [ApiKubectl.RestartedAt]: new Date(this.clock.Now()).toISOString() }
        const body = { spec: { template: { metadata: { annotations } } } }
        return this.client.Patch(ApiKubectl.DeploymentPath(namespace, deployment), body, KubeContentType.StrategicMerge)
    }

    public async RolloutRestartSelector(namespace: string, selector: string): Promise<void>
    {
        const items = await this.client.List(KubeResourceCatalog.PathOf(ApiKubectl.DeploymentType, namespace), selector)
        for (const item of items)
        {
            await this.RolloutRestart(namespace, ApiKubectl.NameOf(item))
        }
    }

    public async RolloutStatus(namespace: string, deployment: string): Promise<void>
    {
        const path = ApiKubectl.DeploymentPath(namespace, deployment)
        for (let attempt = 0; attempt < this.rollout.attempts; attempt++)
        {
            const state = await this.client.Get(path) as DeploymentState | undefined
            if (state === undefined)
            {
                throw new KubeApiError(ApiKubectl.NotFound, KubeMethod.Get, path, undefined)
            }
            if (ApiKubectl.IsRolledOut(state))
            {
                return
            }
            if (attempt + 1 < this.rollout.attempts)
            {
                await this.clock.Delay(this.rollout.intervalMs)
            }
        }
        throw new RolloutTimeoutError(namespace, deployment)
    }

    public async DeleteNamespace(namespace: string): Promise<void>
    {
        const path = KubeResourceCatalog.PathOf(KubeResourceCatalog.NamespaceType, undefined, namespace)
        if (await this.client.Delete(path))
        {
            await this.WaitGone(path, ApiKubectl.NamespaceLabel + namespace)
        }
    }

    /** Polls until the object is gone (kubectl delete waits for finalizers); bounded like RolloutStatus. */
    private async WaitGone(path: string, label: string): Promise<void>
    {
        for (let attempt = 0; attempt < this.rollout.attempts; attempt++)
        {
            if (await this.client.Get(path) === undefined)
            {
                return
            }
            if (attempt + 1 < this.rollout.attempts)
            {
                await this.clock.Delay(this.rollout.intervalMs)
            }
        }
        throw new DeleteTimeoutError(label)
    }

    public async DeleteManifest(manifestJson: string): Promise<void>
    {
        for (const item of ApiKubectl.ItemsOf(manifestJson))
        {
            await this.client.Delete(ApiKubectl.PathOfObject(item))
        }
    }

    public async DeleteBySelector(namespace: string, resource: string, selector: string): Promise<void>
    {
        for (const word of resource.split(ApiKubectl.Comma))
        {
            const type = KubeResourceCatalog.ParseResource(word.trim()).type
            const items = await this.client.List(KubeResourceCatalog.PathOf(type, namespace), selector)
            const deleted: Array<{ path: string; label: string }> = []
            for (const item of items)
            {
                const path = KubeResourceCatalog.PathOf(type, namespace, ApiKubectl.NameOf(item))
                if (await this.client.Delete(path))
                {
                    deleted.push({ path, label: type.kind.toLowerCase() + ApiKubectl.Slash + ApiKubectl.NameOf(item) })
                }
            }
            for (const entry of deleted)
            {
                await this.WaitGone(entry.path, entry.label)
            }
        }
    }

    public async DeleteNamespacesBySelector(selector: string, namePrefix: string): Promise<string[]>
    {
        const items = await this.client.List(KubeResourceCatalog.PathOf(KubeResourceCatalog.NamespaceType, undefined), selector)
        const names = NamespaceSweep.Select(items.map(i => ApiKubectl.NameOf(i)), namePrefix)
        return NamespaceSweep.DeleteEach(names, name => this.DeleteNamespace(name))
    }

    private static IsRolledOut(state: DeploymentState): boolean
    {
        const replicas = state.spec?.replicas ?? ApiKubectl.DefaultReplicas
        if (replicas === 0)
        {
            return true
        }
        const status = state.status ?? {}
        const updated = status.updatedReplicas ?? 0
        return (status.observedGeneration ?? 0) >= (state.metadata?.generation ?? 0)
            && updated === replicas
            && (status.replicas ?? 0) === updated
            && (status.availableReplicas ?? 0) >= updated
    }

    private static DeploymentPath(namespace: string, deployment: string): string
    {
        return KubeResourceCatalog.PathOf(ApiKubectl.DeploymentType, namespace, deployment)
    }

    private static PathOfResource(namespace: string, resource: string): string
    {
        const parsed = KubeResourceCatalog.ParseResource(resource)
        return KubeResourceCatalog.PathOf(parsed.type, namespace, parsed.name)
    }

    private static PathOfObject(item: ManifestObject): string
    {
        if (item.metadata.namespace === undefined && KubeResourceCatalog.IsNamespaced(item))
        {
            throw new KubectlError(ApiKubectl.MissingNamespacePrefix + item.kind + '/' + item.metadata.name, '', false)
        }
        return KubeResourceCatalog.PathOf(item, item.metadata.namespace, item.metadata.name)
    }

    private static NameOf(item: unknown): string
    {
        return (item as { metadata: { name: string } }).metadata.name
    }

    /** A List's items in order, or the single object; bad JSON fails with a fixed message (the manifest may hold Secret data). */
    private static ItemsOf(manifestJson: string): ManifestObject[]
    {
        let parsed: { kind?: string; items?: ManifestObject[] }
        try
        {
            parsed = JSON.parse(manifestJson) as { kind?: string; items?: ManifestObject[] }
        }
        catch
        {
            throw new KubectlError(ApiKubectl.BadManifestMessage, '', false)
        }
        return parsed.kind === KubeResourceCatalog.ListKind ? parsed.items ?? [] : [parsed as unknown as ManifestObject]
    }
}
