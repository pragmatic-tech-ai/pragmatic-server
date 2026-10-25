import type { HiveRecord, TenantRecord } from '../platform-records.js'

/**
 * The narrow platform-directory read seam the tenant plane depends on: only what it reads, nothing it could mutate.
 * `PlatformDirectory` satisfies it structurally; a tenant-local implementation can supply the same reads.
 */
export interface ITenantDirectory
{
    GetTenant(id: string): TenantRecord | undefined
    GetHive(id: string): HiveRecord | undefined
    ListHives(tenantId: string): readonly HiveRecord[]
}
