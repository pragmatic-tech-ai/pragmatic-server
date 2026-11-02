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

export class HiveBootstrapBundle
{
    private static readonly FilePrefix = 'bootstrap-'
    private static readonly FileExtension = '.json'
    private static readonly JsonIndent = 2

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
}
