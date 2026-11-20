import { ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'
import type { EnvironmentRecord } from '../environment-record.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { ReleaseApp } from '../release/release-tag.js'

/** One deployment a component's configuration can be applied to: the environment it serves and its place in the hive. */
export type ConfigurationTargetDto = { environment: string; hive: string; namespace: string; deployment: string }

/** The environment records the targets are read from. */
export interface IEnvironmentList
{
    List(): readonly EnvironmentRecord[]
}

/**
 * Where a component's configuration goes: the deployments this console writes itself. That is every environment server of
 * the tenant's hive-bound environments (its namespace and deployment, as the console's manifests name them: the
 * console's environment role may write ConfigMaps and patch Deployments there). The hive's own components (the console,
 * the realm sign-in service, the agent) run in pragmatic-system, which the console may not write: their configuration
 * versions are kept here and reach them with pull-only management (stage C step 4: the platform's intent, the agent's
 * apply), so they have no target yet.
 */
export class ConfigurationTargets
{
    public constructor(private readonly environments: IEnvironmentList)
    {
    }

    /** The targets of `component` in `tenantId`'s environments, by environment name. */
    public For(component: string, tenantId: string): { environment: string; target: ApplyTarget }[]
    {
        if (component !== ReleaseApp.EnvServer)
        {
            return []
        }
        return this.environments.List()
            .filter(r => r.tenantId === tenantId && r.hiveId !== undefined)
            .sort((a, b) => a.name.localeCompare(b.name))
            .flatMap(r => ConfigurationTargets.TargetOf(r))
    }

    /** Whether `tenantId` has an environment named `environment` (a target or not). */
    public Has(tenantId: string, environment: string): boolean
    {
        return this.environments.List().some(r => r.tenantId === tenantId && r.name === environment)
    }

    /** The target of one environment, or none when its names are not DNS labels (never a deployment the console wrote). */
    private static TargetOf(record: EnvironmentRecord): { environment: string; target: ApplyTarget }[]
    {
        try
        {
            const target = new ApplyTarget(record.hiveId as string, K8sManifestBuilder.NamespaceOf(record.name), K8sManifestBuilder.ServerDeploymentOf(record.name))
            return [{ environment: record.name, target }]
        }
        catch
        {
            return []
        }
    }

    public static ToDto(environment: string, target: ApplyTarget): ConfigurationTargetDto
    {
        return { environment, hive: target.Hive, namespace: target.Namespace, deployment: target.Deployment }
    }
}
