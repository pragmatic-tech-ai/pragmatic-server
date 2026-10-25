import type { ManifestRecord } from '../manifest-record.js'
import type { HiveRolloutStatus } from '../platform-deployment-registry.js'

/** The narrow rollout seam the tenant plane depends on: read a tenant's gated manifests and a hive's rollout status, and adopt a target version. */
export interface IRolloutClient
{
    ManifestsFor(tenantId: string): readonly ManifestRecord[]
    StatusFor(hiveId: string): HiveRolloutStatus
    AdoptTarget(hiveId: string, version: string): Promise<void>
}
