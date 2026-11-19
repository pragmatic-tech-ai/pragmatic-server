import type { IConsoleAdvertLookup } from './console-advert-registry.js'
import { DesktopTenantMatcher } from './desktop-tenant-matcher.js'
import type { IDiscoveryDirectory, IDomainApprovalSource, IFingerprintKeySource } from './desktop-tenant-matcher.js'
import { PlaneHttp } from './plane-http.js'
import type { TenantAccountIndex } from './tenant-account-index.js'

/** Whether the platform manages environments for a tenant (EnvironmentRegistry satisfies it). */
export interface IPlatformEnvironmentSource
{
    HasEnvironmentsOf(tenantId: string): boolean
}

/** A discovery answer: HTTP status plus JSON body. */
export interface DiscoveryReply
{
    Status: number
    Body: unknown
}

/** Answers "which tenant(s) does this email belong to": in-process over the platform records (all, admin), or remote
 *  over admin's internal API (edge). Origin, size and throttle checks happen before, in DesktopDiscoveryEndpoint. */
export interface IDesktopDiscoveryBackend
{
    Discover(email: string): Promise<DiscoveryReply>
}

/**
 * Matching over the platform records (DesktopTenantMatcher; the fingerprint keys are sealed under the master key, so
 * this only ever runs on admin or `all`). Per tenant, the console to sign in at: an in-hive tenant's advertised console,
 * else the tenant plane. With no tenant plane configured, only in-hive tenants are answered and the reply carries no
 * `tenantPlaneUrl`.
 */
export class LocalDesktopDiscoveryBackend implements IDesktopDiscoveryBackend
{
    private static readonly StatusNotFound = 404
    private static readonly NoAccountBody = { error: 'no-account' }
    private static readonly PlatformEnvironmentsField = 'platformEnvironments'
    private static readonly NoTenantPlane = ''

    private readonly matcher: DesktopTenantMatcher

    public constructor(
        index: TenantAccountIndex,
        directory: IDiscoveryDirectory,
        private readonly tenantPlaneUrl: string | undefined,
        adverts?: IConsoleAdvertLookup,
        keys?: IFingerprintKeySource,
        approvals?: IDomainApprovalSource,
        private readonly platformEnvironments?: IPlatformEnvironmentSource)
    {
        this.matcher = new DesktopTenantMatcher(index, directory, adverts, keys, approvals)
    }

    public async Discover(email: string): Promise<DiscoveryReply>
    {
        const L = LocalDesktopDiscoveryBackend
        const plane = this.tenantPlaneUrl
        const tenants = (await this.matcher.Match(email, plane ?? L.NoTenantPlane))
            .filter(d => plane !== undefined || d.inHive)
            .map(d => ({
                id: d.tenant.id, displayName: d.tenant.displayName, consoleUrl: d.consoleUrl,
                ...(d.inHive && this.platformEnvironments?.HasEnvironmentsOf(d.tenant.id) === true ? { [L.PlatformEnvironmentsField]: true } : {})
            }))
        if (tenants.length === 0)
        {
            return { Status: L.StatusNotFound, Body: L.NoAccountBody }
        }
        return { Status: PlaneHttp.StatusOk, Body: plane === undefined ? { tenants } : { tenants, tenantPlaneUrl: plane } }
    }
}
