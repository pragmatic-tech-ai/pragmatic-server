import type { PlatformDeploymentRegistry, HiveRolloutStatus } from '../platform-deployment-registry.js'
import type { ManifestRecord } from '../manifest-record.js'
import type { IRolloutClient } from './rollout-client.js'

/** Collapsed-dev adapter: serves the tenant rollout seam in-process from the operator's `PlatformDeploymentRegistry`. */
export class InProcessRolloutClient implements IRolloutClient
{
    public constructor(private readonly deployments: PlatformDeploymentRegistry)
    {
    }

    public ManifestsFor(tenantId: string): readonly ManifestRecord[]
    {
        return this.deployments.ManifestsFor(tenantId)
    }

    public StatusFor(hiveId: string): HiveRolloutStatus
    {
        return this.deployments.StatusFor(hiveId)
    }

    public AdoptTarget(hiveId: string, version: string): Promise<void>
    {
        return this.deployments.SelectTarget(hiveId, version)
    }
}
