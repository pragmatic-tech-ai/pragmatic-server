import { HiveBootstrapBundle } from './hive-bootstrap-bundle.js'
import type { IInstallOrchestratorSource } from './hive-agent-installer.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KubectlError } from './kubectl.js'
import { HiveBackend, InfraMode, type HiveRecord } from './platform-records.js'

/**
 * The hive's agent could not be removed from its cluster. Carries a fixed reason or kubectl's (already redacted) text,
 * and the operator's two ways forward. The host answers it with 409 and `Code`, so the portal can offer delete anyway.
 */
export class AgentUninstallError extends Error
{
    /** The machine-readable code the host puts beside the message. */
    public static readonly Code = 'agent-uninstall-failed'
    private static readonly ErrorName = 'AgentUninstallError'
    private static readonly Prefix = "Could not remove the hive's agent from its cluster: "
    private static readonly Suffix = '. Fix cluster access and retry, or delete anyway to remove only the platform record.'
    private static readonly UnreachableReason = 'the cluster could not be reached'
    private static readonly TrailingStop = /\.+$/

    public constructor(cause: unknown)
    {
        super(AgentUninstallError.Prefix + AgentUninstallError.ReasonOf(cause) + AgentUninstallError.Suffix)
        this.name = AgentUninstallError.ErrorName
    }

    private static ReasonOf(cause: unknown): string
    {
        const reason = cause instanceof KubectlError ? cause.message : AgentUninstallError.UnreachableReason
        return reason.trim().replace(AgentUninstallError.TrailingStop, '')
    }
}

/**
 * Removes a hive's agent from a cluster the control plane drives, for a hive delete: the bundle's objects except the
 * shared Namespace, the token Secret, and every Deployment labelled for the hive in pragmatic-system (the agent and, when
 * installed, the tenant-admin pod). Deletes tolerate objects already gone, so a half-installed or hand-removed agent
 * uninstalls cleanly. Covers attached Local hives only: a provisioned (kind) hive's whole cluster is destroyed on delete,
 * which removes the agent with it, and the platform never touches other backends' clusters.
 */
export class HiveAgentUninstaller
{
    private static readonly DeploymentResource = 'deployment'

    public constructor(private readonly orchestrators: IInstallOrchestratorSource)
    {
    }

    /** Whether a delete of this hive uninstalls its agent first. */
    public Covers(hive: HiveRecord): boolean
    {
        return hive.cluster.backend === HiveBackend.Local && hive.cluster.mode === InfraMode.Attach
    }

    /** Removes the agent's objects; throws AgentUninstallError when the cluster refuses or cannot be reached. */
    public async Uninstall(hive: HiveRecord): Promise<void>
    {
        try
        {
            const kubectl = this.orchestrators.For(hive).Kubectl
            await kubectl.DeleteManifest(HiveBootstrapBundle.RemovalManifest(hive.id))
            await kubectl.DeleteBySelector(K8sManifestBuilder.SystemNamespace, HiveAgentUninstaller.DeploymentResource, K8sManifestBuilder.HiveLabelSelectorOf(hive.id))
        }
        catch (err)
        {
            throw new AgentUninstallError(err)
        }
    }
}
