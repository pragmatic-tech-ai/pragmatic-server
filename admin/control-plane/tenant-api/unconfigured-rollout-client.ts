import type { HiveRolloutStatus } from '../platform-deployment-registry.js'
import type { ManifestRecord } from '../manifest-record.js'
import { RolloutUnavailableError, type IRolloutClient } from './rollout-client.js'

/**
 * Placeholder rollout client for a standalone tenant-admin process that has no operator link yet: every
 * read and action fails closed with a RolloutUnavailableError (the tenant API answers 503). The real (HTTP) client replaces it when the container is wired.
 */
export class UnconfiguredRolloutClient implements IRolloutClient
{
    private static readonly Message = 'No rollout client is configured for this tenant-admin process'

    public ManifestsFor(_tenantId: string): Promise<readonly ManifestRecord[]>
    {
        return Promise.reject(new RolloutUnavailableError(UnconfiguredRolloutClient.Message))
    }

    public StatusFor(_hiveId: string): Promise<HiveRolloutStatus>
    {
        return Promise.reject(new RolloutUnavailableError(UnconfiguredRolloutClient.Message))
    }

    public AdoptTarget(_hiveId: string, _version: string): Promise<void>
    {
        return Promise.reject(new RolloutUnavailableError(UnconfiguredRolloutClient.Message))
    }
}
