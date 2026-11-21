import type { IConsoleAdvertLookup } from './console-advert-registry.js'
import { DesktopTenantMatcher, type IDiscoveryDirectory, type IDomainApprovalSource, type IFingerprintKeySource } from './desktop-tenant-matcher.js'
import { PlaneHttp, type DiscoveryReply, type IDesktopDiscoveryBackend } from '@pragmatic-tech-ai/pragmatic-platform-link'
import type { TenantAccountIndex } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** Whether the platform manages environments for a tenant (EnvironmentRegistry satisfies it). */
export interface IPlatformEnvironmentSource
{
    HasEnvironmentsOf(tenantId: string): boolean
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
