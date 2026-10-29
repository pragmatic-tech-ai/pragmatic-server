import type { PlatformDeploymentRegistry, HiveRolloutStatus } from '../platform-deployment-registry.js'
import type { ManifestRecord } from '../manifest-record.js'
import { AdoptionLedgerDtoMapper, type AdoptionLedgerDto, type IRolloutClient } from './rollout-client.js'

/** Collapsed-dev adapter: serves the tenant rollout seam in-process from the operator's `PlatformDeploymentRegistry`. */
export class InProcessRolloutClient implements IRolloutClient
{
    public constructor(private readonly deployments: PlatformDeploymentRegistry)
    {
    }

    public ManifestsFor(tenantId: string): Promise<readonly ManifestRecord[]>
    {
        return Promise.resolve(this.deployments.AdoptableForTenant(tenantId))
    }

    public StatusFor(hiveId: string): Promise<HiveRolloutStatus>
    {
        return Promise.resolve(this.deployments.StatusFor(hiveId))
    }

    public AdoptTarget(hiveId: string, version: string): Promise<void>
    {
        return this.deployments.SelectTarget(hiveId, version)
    }

    public LedgerFor(hiveId: string, limit: number): Promise<readonly AdoptionLedgerDto[]>
    {
        return Promise.resolve(AdoptionLedgerDtoMapper.ToDtos(this.deployments.LedgerForHive(hiveId, limit)))
    }
}
