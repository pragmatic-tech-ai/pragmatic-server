import type { HiveRolloutStatus } from '../platform-deployment-registry.js'
import type { ManifestRecord } from '../manifest-record.js'
import type { IRolloutClient } from './rollout-client.js'

/**
 * Placeholder rollout client for a standalone tenant-admin process that has no operator link yet: reads report
 * nothing and any rollout action fails loudly. The real (HTTP) client replaces it when the container is wired.
 */
export class UnconfiguredRolloutClient implements IRolloutClient
{
    private static readonly Message = 'No rollout client is configured for this tenant-admin process'

    public ManifestsFor(_tenantId: string): readonly ManifestRecord[]
    {
        return []
    }

    public StatusFor(_hiveId: string): HiveRolloutStatus
    {
        throw new Error(UnconfiguredRolloutClient.Message)
    }

    public AdoptTarget(_hiveId: string, _version: string): Promise<void>
    {
        return Promise.reject(new Error(UnconfiguredRolloutClient.Message))
    }
}
