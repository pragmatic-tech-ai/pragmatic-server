import type { IdpConnection } from './idp-workload-driver.js'
import type { IIdpService } from './idp-service.js'

/**
 * The IdP service of a tenant admin that was given no IdP (no PRAGMATIC_IDP_* injection, so outside a provisioned console
 * pod): it knows no tenant IdP, cannot launch one (launching is the platform's job, never the in-hive console's), and has
 * nothing to tear down.
 */
export class UnconfiguredIdpService implements IIdpService
{
    private static readonly Message = 'No identity provider is configured for this tenant-admin process'

    public EnsureForTenant(_tenantId: string, _displayName: string): Promise<IdpConnection>
    {
        return Promise.reject(new Error(UnconfiguredIdpService.Message))
    }

    public async ConnectForTenant(_tenantId: string): Promise<IdpConnection | undefined>
    {
        return undefined
    }

    public async TeardownForTenant(_tenantId: string): Promise<void>
    {
    }
}
