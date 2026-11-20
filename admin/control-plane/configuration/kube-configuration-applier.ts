import { AppliedConfigurationCodec, type AppliedConfiguration, type ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import { KubeContentType, KubeResourceCatalog, type KubeApiClient } from '../kube-api-client.js'

/** Writes an applied configuration next to its deployment and rolls the deployment. */
export interface IConfigurationApplier
{
    /** Whether this console can write to its cluster at all (it runs in a pod). */
    readonly Available: boolean
    Apply(applied: AppliedConfiguration, target: ApplyTarget): Promise<void>
}

/** The console runs outside a cluster: there is nothing to write to. */
export class ConfigurationApplyUnavailableError extends Error
{
    private static readonly ErrorName = 'ConfigurationApplyUnavailableError'
    private static readonly Text = 'This console cannot reach its cluster, so a configuration cannot be applied here.'

    public constructor()
    {
        super(ConfigurationApplyUnavailableError.Text)
        this.name = ConfigurationApplyUnavailableError.ErrorName
    }
}

/**
 * The applier over the console's own Kubernetes access (its pod's service account): the ConfigMap
 * `pragmatic-config-<component>` (server-side apply, so it is created or updated in place under the same name) in the
 * deployment's namespace, then the content hash on the deployment's pod template (a strategic-merge patch of
 * `spec.template.metadata.annotations`), which rolls the deployment when the content changed. Nothing in either is secret
 * (secret settings are references).
 */
export class KubeConfigurationApplier implements IConfigurationApplier
{
    private static readonly ConfigMapType = { apiVersion: 'v1', kind: 'ConfigMap' }
    private static readonly DeploymentType = { apiVersion: 'apps/v1', kind: 'Deployment' }

    public constructor(private readonly client: KubeApiClient)
    {
    }

    public get Available(): boolean
    {
        return true
    }

    public async Apply(applied: AppliedConfiguration, target: ApplyTarget): Promise<void>
    {
        const K = KubeConfigurationApplier
        const configMap = AppliedConfigurationCodec.ToConfigMap(applied, target.Namespace)
        await this.client.Apply(KubeResourceCatalog.PathOf(K.ConfigMapType, target.Namespace, configMap.metadata.name), configMap)
        const roll = { spec: { template: { metadata: { annotations: AppliedConfigurationCodec.PodTemplateAnnotations(applied) } } } }
        await this.client.Patch(KubeResourceCatalog.PathOf(K.DeploymentType, target.Namespace, target.Deployment), roll, KubeContentType.StrategicMerge)
    }
}

/** The applier of a console outside a cluster: every apply is refused. */
export class UnavailableConfigurationApplier implements IConfigurationApplier
{
    public get Available(): boolean
    {
        return false
    }

    public async Apply(): Promise<void>
    {
        throw new ConfigurationApplyUnavailableError()
    }
}
