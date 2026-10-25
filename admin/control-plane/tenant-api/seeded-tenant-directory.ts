import type { HiveRecord, TenantRecord } from '../platform-records.js'
import type { ITenantDirectory } from './tenant-directory.js'

export type TenantDirectorySeed = {
    readonly tenant: TenantRecord
    readonly hives: readonly HiveRecord[]
}

/**
 * A read-only ITenantDirectory scoped to exactly one tenant and its hives, seeded from startup config.
 * Any other tenant or hive id resolves to undefined / empty.
 */
export class SeededTenantDirectory implements ITenantDirectory
{
    private readonly tenant: TenantRecord
    private readonly hives: readonly HiveRecord[]

    public constructor(seed: TenantDirectorySeed)
    {
        this.tenant = seed.tenant
        this.hives = [...seed.hives]
    }

    public GetTenant(id: string): TenantRecord | undefined
    {
        return id === this.tenant.id ? this.tenant : undefined
    }

    public GetHive(id: string): HiveRecord | undefined
    {
        return this.hives.find(h => h.id === id)
    }

    public ListHives(tenantId: string): readonly HiveRecord[]
    {
        return this.hives.filter(h => h.tenantId === tenantId)
    }
}
