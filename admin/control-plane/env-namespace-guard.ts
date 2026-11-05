import { KubectlError, type IKubectl } from './kubectl.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KubeResourceCatalog, type KubeTypeRef } from './kube-api-client.js'

/** Why the console refused a namespace, an object or a workload. */
export enum EnvNamespaceRefusal
{
    /** The call or a manifest item reaches outside the console's `pragmatic-env-*` namespaces. */
    OutsidePrefix = 'outside-prefix',
    /** The environment namespace already exists and is not labelled for this hive. */
    OtherHive = 'other-hive',
    /** The environment namespace is this hive's but does not enforce the baseline or restricted Pod Security level. */
    NoPodSecurity = 'no-pod-security',
    /** The workload belongs to another hive than the console's own. */
    WorkloadOfOtherHive = 'workload-of-other-hive',
}

/**
 * A refusal; the message is a plain sentence naming only `Target`: the namespace, the object (`Kind/name`, `kind/name`) or, for
 * WorkloadOfOtherHive, the hive the workload belongs to.
 */
export class EnvNamespaceRefusedError extends Error
{
    private static readonly ErrorName = 'EnvNamespaceRefusedError'
    private static readonly Sentences: Readonly<Record<EnvNamespaceRefusal, readonly [string, string]>> = {
        [EnvNamespaceRefusal.OutsidePrefix]: ['The tenant console manages only its own namespaces named pragmatic-env-*: ', ''],
        [EnvNamespaceRefusal.OtherHive]: ['The environment namespace already exists and does not belong to this hive: ', ''],
        [EnvNamespaceRefusal.NoPodSecurity]: ['The environment namespace ', ' does not enforce the baseline or restricted Pod Security level; re-apply the environment from the platform to label it.'],
        [EnvNamespaceRefusal.WorkloadOfOtherHive]: ['The tenant console manages only its own hive; this environment belongs to hive: ', ''],
    }

    public constructor(public readonly Target: string, public readonly Refusal: EnvNamespaceRefusal = EnvNamespaceRefusal.OutsidePrefix)
    {
        const [before, after] = EnvNamespaceRefusedError.Sentences[Refusal]
        super(before + Target + after)
        this.name = EnvNamespaceRefusedError.ErrorName
    }
}

type GuardedItem = { apiVersion?: unknown; kind?: unknown; metadata?: { name?: unknown; namespace?: unknown } }

/**
 * The console's client-side fence: every IKubectl call must stay inside `pragmatic-env-*` namespaces. A namespaced verb needs an
 * env namespace; a manifest may hold only namespaced kinds in env namespaces or `Namespace` objects named `pragmatic-env-*`; a
 * Get/Find/DeleteBySelector may name only namespaced kinds (or the env Namespace itself). Refusals happen before `inner` is
 * reached. The API server's admission policy (TenantConsoleAdmission) enforces the same rule server-side.
 */
export class EnvNamespaceGuard implements IKubectl
{
    private static readonly BadManifestMessage = 'kubectl manifest was not valid JSON'
    private static readonly Slash = '/'
    private static readonly Comma = ','
    private static readonly Unnamed = '(unnamed)'

    public constructor(private readonly inner: IKubectl)
    {
    }

    /** True for `pragmatic-env-<something>`. */
    public static IsEnvNamespace(namespace: string): boolean
    {
        const prefix = K8sManifestBuilder.EnvNamespacePrefix
        return namespace.startsWith(prefix) && namespace.length > prefix.length
    }

    /** Refuses a namespace outside the env prefix. */
    public static AssertEnvNamespace(namespace: string): void
    {
        if (!EnvNamespaceGuard.IsEnvNamespace(namespace))
        {
            throw new EnvNamespaceRefusedError(namespace)
        }
    }

    /**
     * Refuses to adopt an existing environment namespace (`existing`, as the API returns it) unless it is labelled for `hiveId`;
     * an absent namespace (`undefined`) is fine. An unlabelled one was not made by the platform and is refused too.
     */
    public static AssertHiveOwns(existing: unknown, namespace: string, hiveId: string): void
    {
        if (existing !== undefined && K8sManifestBuilder.HiveOf(existing) !== hiveId)
        {
            throw new EnvNamespaceRefusedError(namespace, EnvNamespaceRefusal.OtherHive)
        }
    }

    /**
     * Refuses an existing environment namespace that does not enforce an admitted Pod Security level (one made before env namespaces
     * carried the label): the console cannot relabel it, and binding its env role there would allow privileged pods.
     */
    public static AssertPodSecurityEnforced(existing: unknown, namespace: string): void
    {
        if (!K8sManifestBuilder.EnforcesAdmittedPodSecurity(existing))
        {
            throw new EnvNamespaceRefusedError(namespace, EnvNamespaceRefusal.NoPodSecurity)
        }
    }

    public async Apply(manifestJson: string): Promise<void>
    {
        EnvNamespaceGuard.AssertManifest(manifestJson)
        await this.inner.Apply(manifestJson)
    }

    public async ApplyServerSide(manifestJson: string): Promise<void>
    {
        EnvNamespaceGuard.AssertManifest(manifestJson)
        await this.inner.ApplyServerSide(manifestJson)
    }

    public async DeleteManifest(manifestJson: string): Promise<void>
    {
        EnvNamespaceGuard.AssertManifest(manifestJson)
        await this.inner.DeleteManifest(manifestJson)
    }

    public async Get(namespace: string, resource: string): Promise<string>
    {
        EnvNamespaceGuard.AssertResource(namespace, resource)
        return this.inner.Get(namespace, resource)
    }

    public async Find(namespace: string, resource: string): Promise<string | undefined>
    {
        EnvNamespaceGuard.AssertResource(namespace, resource)
        return this.inner.Find(namespace, resource)
    }

    public async DeleteBySelector(namespace: string, resource: string, selector: string): Promise<void>
    {
        EnvNamespaceGuard.AssertEnvNamespace(namespace)
        for (const word of resource.split(EnvNamespaceGuard.Comma))
        {
            EnvNamespaceGuard.AssertNamespacedKind(namespace, word.trim())
        }
        await this.inner.DeleteBySelector(namespace, resource, selector)
    }

    /** Only the env prefix itself (or a longer prefix inside it): the sweep never reaches a namespace outside pragmatic-env-*. */
    public async DeleteNamespacesBySelector(selector: string, namePrefix: string): Promise<string[]>
    {
        if (!namePrefix.startsWith(K8sManifestBuilder.EnvNamespacePrefix))
        {
            throw new EnvNamespaceRefusedError(namePrefix)
        }
        return this.inner.DeleteNamespacesBySelector(selector, namePrefix)
    }

    public async RolloutStatus(namespace: string, deployment: string): Promise<void>
    {
        EnvNamespaceGuard.AssertEnvNamespace(namespace)
        await this.inner.RolloutStatus(namespace, deployment)
    }

    public async SetImage(namespace: string, deployment: string, container: string, image: string): Promise<void>
    {
        EnvNamespaceGuard.AssertEnvNamespace(namespace)
        await this.inner.SetImage(namespace, deployment, container, image)
    }

    public async Scale(namespace: string, deployment: string, replicas: number): Promise<void>
    {
        EnvNamespaceGuard.AssertEnvNamespace(namespace)
        await this.inner.Scale(namespace, deployment, replicas)
    }

    public async ScaleStatefulSet(namespace: string, statefulSet: string, replicas: number): Promise<void>
    {
        EnvNamespaceGuard.AssertEnvNamespace(namespace)
        await this.inner.ScaleStatefulSet(namespace, statefulSet, replicas)
    }

    public async RolloutRestart(namespace: string, deployment: string): Promise<void>
    {
        EnvNamespaceGuard.AssertEnvNamespace(namespace)
        await this.inner.RolloutRestart(namespace, deployment)
    }

    public async RolloutRestartSelector(namespace: string, selector: string): Promise<void>
    {
        EnvNamespaceGuard.AssertEnvNamespace(namespace)
        await this.inner.RolloutRestartSelector(namespace, selector)
    }

    public async DeleteNamespace(namespace: string): Promise<void>
    {
        EnvNamespaceGuard.AssertEnvNamespace(namespace)
        await this.inner.DeleteNamespace(namespace)
    }

    /** `namespace` is an env namespace and `resource` names a namespaced kind, or the env Namespace object itself. */
    private static AssertResource(namespace: string, resource: string): void
    {
        EnvNamespaceGuard.AssertEnvNamespace(namespace)
        const parsed = EnvNamespaceGuard.ParseOrRefuse(namespace, resource)
        if (EnvNamespaceGuard.IsNamespaceType(parsed.type))
        {
            EnvNamespaceGuard.AssertEnvNamespace(parsed.name ?? resource)
            return
        }
        if (!EnvNamespaceGuard.NamespacedOrRefuse(parsed.type, resource))
        {
            throw new EnvNamespaceRefusedError(resource)
        }
    }

    private static AssertNamespacedKind(namespace: string, resource: string): void
    {
        const parsed = EnvNamespaceGuard.ParseOrRefuse(namespace, resource)
        if (!EnvNamespaceGuard.NamespacedOrRefuse(parsed.type, resource))
        {
            throw new EnvNamespaceRefusedError(resource)
        }
    }

    private static ParseOrRefuse(namespace: string, resource: string): { type: KubeTypeRef; name: string | undefined }
    {
        try
        {
            return KubeResourceCatalog.ParseResource(resource)
        }
        catch
        {
            throw new EnvNamespaceRefusedError(namespace + EnvNamespaceGuard.Slash + resource)
        }
    }

    /** Whether the kind is namespaced; an unknown kind is refused (its scope cannot be judged). */
    private static NamespacedOrRefuse(type: KubeTypeRef, label: string): boolean
    {
        try
        {
            return KubeResourceCatalog.IsNamespaced(type)
        }
        catch
        {
            throw new EnvNamespaceRefusedError(label)
        }
    }

    private static IsNamespaceType(type: KubeTypeRef): boolean
    {
        return type.apiVersion === KubeResourceCatalog.NamespaceType.apiVersion && type.kind === KubeResourceCatalog.NamespaceType.kind
    }

    /** Every item is a namespaced kind in an env namespace or an env Namespace; bad JSON fails with a fixed message (it may hold Secret data). */
    private static AssertManifest(manifestJson: string): void
    {
        for (const item of EnvNamespaceGuard.ItemsOf(manifestJson))
        {
            EnvNamespaceGuard.AssertItem(item)
        }
    }

    private static AssertItem(item: GuardedItem): void
    {
        const name = typeof item.metadata?.name === 'string' ? item.metadata.name : EnvNamespaceGuard.Unnamed
        const namespace = item.metadata?.namespace
        if (typeof item.apiVersion !== 'string' || typeof item.kind !== 'string')
        {
            throw new EnvNamespaceRefusedError(name)
        }
        const type: KubeTypeRef = { apiVersion: item.apiVersion, kind: item.kind }
        const label = item.kind + EnvNamespaceGuard.Slash + name
        if (EnvNamespaceGuard.IsNamespaceType(type))
        {
            EnvNamespaceGuard.AssertEnvNamespace(name)
            return
        }
        if (!EnvNamespaceGuard.NamespacedOrRefuse(type, label))
        {
            throw new EnvNamespaceRefusedError(label)
        }
        if (typeof namespace !== 'string')
        {
            throw new EnvNamespaceRefusedError(label)
        }
        EnvNamespaceGuard.AssertEnvNamespace(namespace)
    }

    private static ItemsOf(manifestJson: string): GuardedItem[]
    {
        let parsed: { kind?: unknown; items?: unknown }
        try
        {
            parsed = JSON.parse(manifestJson) as { kind?: unknown; items?: unknown }
        }
        catch
        {
            throw new KubectlError(EnvNamespaceGuard.BadManifestMessage, '', false)
        }
        if (parsed === null || typeof parsed !== 'object')
        {
            throw new KubectlError(EnvNamespaceGuard.BadManifestMessage, '', false)
        }
        if (parsed.kind === KubeResourceCatalog.ListKind)
        {
            return Array.isArray(parsed.items) ? parsed.items.map(i => (i ?? {}) as GuardedItem) : []
        }
        return [parsed as GuardedItem]
    }
}
