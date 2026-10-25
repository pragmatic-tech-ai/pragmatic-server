import type { ManifestRecord } from '../manifest-record.js'
import type { HiveRolloutStatus } from '../platform-deployment-registry.js'

/** The narrow rollout seam the tenant plane depends on: read a tenant's gated manifests and a hive's rollout status, and adopt a target version. */
export interface IRolloutClient
{
    ManifestsFor(tenantId: string): Promise<readonly ManifestRecord[]>
    StatusFor(hiveId: string): Promise<HiveRolloutStatus>
    AdoptTarget(hiveId: string, version: string): Promise<void>
}

/** Raised by a rollout client that has no operator link: the tenant API maps it to a clear 503 rather than an opaque 500. */
export class RolloutUnavailableError extends Error
{
    private static readonly ErrorName = 'RolloutUnavailableError'

    public constructor(message: string)
    {
        super(message)
        this.name = RolloutUnavailableError.ErrorName
    }
}

/** Raised when the platform refuses an adoption (version not published or not gated for the tenant); distinct from an unreachable platform. */
export class RolloutAdoptionRefusedError extends Error
{
    private static readonly ErrorName = 'RolloutAdoptionRefusedError'

    public constructor(message: string)
    {
        super(message)
        this.name = RolloutAdoptionRefusedError.ErrorName
    }
}
