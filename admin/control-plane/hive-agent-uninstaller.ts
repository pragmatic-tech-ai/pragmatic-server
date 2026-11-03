import { HiveBootstrapBundle } from './hive-bootstrap-bundle.js'
import type { IInstallOrchestratorSource } from './hive-agent-installer.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KindError } from './kind.js'
import { KubectlError } from './kubectl.js'
import { HiveBackend, InfraMode, type HiveRecord } from './platform-records.js'
import { TenantAdminBootstrap } from './tenant-admin-bootstrap.js'

/**
 * The hive's agent could not be removed from its cluster. Carries kubectl's (already redacted) text, or the fixed reason an
 * id cannot be selected safely, and the operator's two ways forward. The host answers it with 409 and `Code`, so the portal
 * can offer delete anyway.
 */
export class AgentUninstallError extends Error
{
    /** The machine-readable code the host puts beside the message. */
    public static readonly Code = 'agent-uninstall-failed'
    private static readonly ErrorName = 'AgentUninstallError'
    private static readonly Prefix = "Could not remove the hive's agent from its cluster: "
    private static readonly Suffix = '. Fix cluster access and retry, or delete anyway to remove only the platform record.'
    private static readonly TrailingStop = /\.+$/

    public constructor(reason: string)
    {
        super(AgentUninstallError.Prefix + reason.trim().replace(AgentUninstallError.TrailingStop, '') + AgentUninstallError.Suffix)
        this.name = AgentUninstallError.ErrorName
    }
}

/**
 * A provisioned hive's local kind cluster could not be destroyed (kind or Docker down). Carries kind's / kubectl's (already
 * redacted) text. The host answers it with 409 and `Code`; delete anyway skips the destroy and may leave the cluster behind.
 */
export class HiveClusterDestroyError extends Error
{
    public static readonly Code = 'cluster-destroy-failed'
    private static readonly ErrorName = 'HiveClusterDestroyError'
    private static readonly Prefix = "Could not destroy the hive's kind cluster: "
    private static readonly Suffix = '. Fix Docker or kind and retry, or delete anyway to remove only the platform record (the kind cluster may be left behind).'
    private static readonly TrailingStop = /\.+$/

    public constructor(cause: KindError | KubectlError)
    {
        super(HiveClusterDestroyError.Prefix + cause.message.trim().replace(HiveClusterDestroyError.TrailingStop, '') + HiveClusterDestroyError.Suffix)
        this.name = HiveClusterDestroyError.ErrorName
    }

    /** Wraps an exec (kind / kubectl) failure; anything else is not a destroy failure and is rethrown as is. */
    public static From(err: unknown): never
    {
        if (err instanceof KindError || err instanceof KubectlError)
        {
            throw new HiveClusterDestroyError(err)
        }
        throw err
    }
}

/**
 * Removes a hive's agent from a cluster the control plane drives, for a hive delete:
 * - by name: the bundle's objects except the shared Namespace, the token Secret, and the tenant-admin's live-credential
 *   Secret copies (IdP CA, IdP admin token), which older clusters carry unlabelled;
 * - by the hive label: every Deployment, Service, ServiceAccount and Secret in pragmatic-system (the agent, and the
 *   tenant-admin pod with its Service, ServiceAccount and labelled credentials such as a pull secret).
 * Deletes tolerate objects already gone, so a half-installed or hand-removed agent uninstalls cleanly. The tenant-admin data
 * PVC and its seed Secret (the master key that decrypts it) are kept together (Retained); neither is hive-labelled-and-
 * selected: the PVC's kind is not in the selector and the seed Secret is never labelled.
 * Covers attached Local hives only: a provisioned (kind) hive's whole cluster is destroyed on delete, agent included, and the
 * platform never touches other backends' clusters.
 */
export class HiveAgentUninstaller
{
    private static readonly SelectedResources = 'deployment,service,serviceaccount,secret'
    private static readonly UnsafeIdReason = "the hive id is not a valid Kubernetes label value, so its objects cannot be selected safely (a selector could match another hive's)"

    public constructor(private readonly orchestrators: IInstallOrchestratorSource)
    {
    }

    /** Whether a delete of this hive uninstalls its agent first. */
    public Covers(hive: HiveRecord): boolean
    {
        return hive.cluster.backend === HiveBackend.Local && hive.cluster.mode === InfraMode.Attach
    }

    /** The objects an uninstall deliberately keeps: the tenant-admin data PVC and its seed Secret, together. */
    public Retained(hive: HiveRecord): string[]
    {
        return [K8sManifestBuilder.TenantAdminClaimNameOf(hive.tenantId), K8sManifestBuilder.TenantAdminSeedSecretNameOf(hive.tenantId)]
    }

    /**
     * Removes the agent's objects. Throws AgentUninstallError when kubectl fails or the id cannot be selected safely; any other
     * failure is not an uninstall failure and propagates as is.
     */
    public async Uninstall(hive: HiveRecord): Promise<void>
    {
        if (!K8sManifestBuilder.IsValidHiveId(hive.id))
        {
            throw new AgentUninstallError(HiveAgentUninstaller.UnsafeIdReason)
        }
        const kubectl = this.orchestrators.For(hive).Kubectl
        try
        {
            await kubectl.DeleteManifest(HiveBootstrapBundle.RemovalManifest(hive.id))
            await kubectl.DeleteManifest(TenantAdminBootstrap.CredentialRemovalManifest(hive.tenantId))
            await kubectl.DeleteBySelector(K8sManifestBuilder.SystemNamespace, HiveAgentUninstaller.SelectedResources, K8sManifestBuilder.HiveLabelSelectorOf(hive.id))
        }
        catch (err)
        {
            if (err instanceof KubectlError)
            {
                throw new AgentUninstallError(err.message)
            }
            throw err
        }
    }
}
