import { K8sManifestBuilder } from './k8s-manifest-builder.js'

/**
 * What a client applies in their own cluster so a hive's agent dials home: the agent's Kubernetes objects (a v1 List,
 * `kubectl apply -f` ready) and where its one-time token Secret goes. The bundle never carries the token itself; the
 * operator creates that Secret from the token shown once (the platform keeps only its hash).
 */
export type HiveBootstrapDto = {
    hiveId: string
    /** Suggested file name for the manifest download. */
    fileName: string
    /** The agent's objects as pretty-printed JSON (namespace, service account, RBAC, deployment). */
    manifest: string
    /** The namespace the agent and its token Secret live in. */
    namespace: string
    /** The agent deployment's name. */
    agentName: string
    /**
     * Selects the hive's deployments in the namespace that read the token Secret (the agent and, when installed, the
     * tenant-admin pod): restart them all after a token is reissued, since a Secret-sourced env only changes on restart.
     */
    hiveSelector: string
    /** The Secret the agent reads its token from, and the key within it. */
    tokenSecretName: string
    tokenSecretKey: string
    /** The pod-visible agent channel URL the agent dials. */
    channelUrl: string
    /** True when the control plane can install the agent itself (a Local hive): the portal offers the automatic path first. */
    autoInstall: boolean
}

/** An object's identity in a removal manifest: enough for `kubectl delete -f`, no spec or data. */
type K8sIdentity = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string } }

export class HiveBootstrapBundle
{
    private static readonly FilePrefix = 'bootstrap-'
    private static readonly FileExtension = '.json'
    private static readonly JsonIndent = 2
    /** Rendering for removal keeps identities only, so the channel URL (which lands in the Deployment spec) is irrelevant. */
    private static readonly NoChannel = ''
    private static readonly NamespaceKind = 'Namespace'
    private static readonly ListKind = 'List'
    private static readonly SecretKind = 'Secret'
    private static readonly ApiVersionCore = 'v1'

    private constructor()
    {
    }

    public static For(hiveId: string, channelUrl: string, autoInstall: boolean = false): HiveBootstrapDto
    {
        const tokenSecretName = K8sManifestBuilder.AgentTokenSecretNameOf(hiveId)
        const rendered = new K8sManifestBuilder().RenderHiveAgent(hiveId, channelUrl, tokenSecretName)
        return {
            hiveId,
            fileName: HiveBootstrapBundle.FilePrefix + hiveId + HiveBootstrapBundle.FileExtension,
            manifest: JSON.stringify(JSON.parse(rendered), undefined, HiveBootstrapBundle.JsonIndent),
            namespace: K8sManifestBuilder.SystemNamespace,
            agentName: K8sManifestBuilder.HiveAgentNameOf(hiveId),
            hiveSelector: K8sManifestBuilder.HiveLabelSelectorOf(hiveId),
            tokenSecretName,
            tokenSecretKey: K8sManifestBuilder.AgentTokenSecretKey,
            channelUrl,
            autoInstall,
        }
    }

    /**
     * The hive agent's objects to remove from a cluster, as a v1 List of identities: every bundle object except the shared
     * Namespace (other hives' agents live in it), plus the token Secret. Derived from the same render as the bundle, so the
     * names never drift.
     */
    public static RemovalManifest(hiveId: string): string
    {
        const C = HiveBootstrapBundle
        const tokenSecretName = K8sManifestBuilder.AgentTokenSecretNameOf(hiveId)
        const rendered = JSON.parse(new K8sManifestBuilder().RenderHiveAgent(hiveId, C.NoChannel, tokenSecretName)) as { items: K8sIdentity[] }
        const items: K8sIdentity[] = rendered.items
            .filter(i => i.kind !== C.NamespaceKind)
            .map(i => C.Identity(i.apiVersion, i.kind, i.metadata.name, i.metadata.namespace))
        items.push(C.Identity(C.ApiVersionCore, C.SecretKind, tokenSecretName, K8sManifestBuilder.SystemNamespace))
        return JSON.stringify({ apiVersion: C.ApiVersionCore, kind: C.ListKind, items })
    }

    private static Identity(apiVersion: string, kind: string, name: string, namespace: string | undefined): K8sIdentity
    {
        return { apiVersion, kind, metadata: namespace === undefined ? { name } : { name, namespace } }
    }
}
