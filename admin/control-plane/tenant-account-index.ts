import { JsonRecordStore } from './json-record-store.js'
import type { PlatformDirectory } from './platform-directory.js'

export type TenantAccountRecord = {
    id: string
    email: string
    tenantId: string
    principalId: string
}

/**
 * The platform's own index of which accounts sign in to which tenant console, keyed by email. Accounts live inside
 * per-tenant IdPs that cannot be queried cheaply, so desktop email discovery answers from this index instead.
 *
 * Rule: the index covers every account that can sign in to the tenant console. Today the platform's only
 * account-creating path is TenantProvisioningService (Owner seeding); any future account-creation path MUST call
 * `Record` (and `ForgetTenant` when the tenant goes away), or those accounts will be invisible to discovery.
 */
export class TenantAccountIndex extends JsonRecordStore<TenantAccountRecord>
{
    private static readonly RootKey = 'accounts'
    private static readonly IdSeparator = '/'

    public constructor(filePath: string)
    {
        super(filePath, TenantAccountIndex.RootKey)
    }

    /** Emails are matched trimmed and case-insensitively. */
    public static Normalise(email: string): string
    {
        return email.trim().toLowerCase()
    }

    private static IdOf(tenantId: string, principalId: string): string
    {
        return tenantId + TenantAccountIndex.IdSeparator + principalId
    }

    /** Records (or replaces) the account of one principal; a changed email overwrites the old entry. */
    public async Record(tenantId: string, principalId: string, email: string): Promise<void>
    {
        await this.Put({ id: TenantAccountIndex.IdOf(tenantId, principalId), email: TenantAccountIndex.Normalise(email), tenantId, principalId })
    }

    public async ForgetTenant(tenantId: string): Promise<void>
    {
        const doomed = [...this.Values()].filter(r => r.tenantId === tenantId).map(r => r.id)
        for (const id of doomed)
        {
            await this.Remove(id)
        }
    }

    /** Distinct ids of the tenants this email has an account in. */
    public TenantsFor(email: string): readonly string[]
    {
        const wanted = TenantAccountIndex.Normalise(email)
        const found = new Set<string>()
        for (const record of this.Values())
        {
            if (record.email === wanted)
            {
                found.add(record.tenantId)
            }
        }
        return [...found]
    }

    /**
     * Reconciles the index with the directory: drops rows whose tenant no longer exists, and indexes every directory
     * tenant's recorded Owner that is not yet indexed. Returns how many were added.
     */
    public async BackfillFrom(directory: PlatformDirectory): Promise<number>
    {
        const orphans = [...this.Values()].filter(r => directory.GetTenant(r.tenantId) === undefined).map(r => r.id)
        for (const id of orphans)
        {
            await this.Remove(id)
        }
        let added = 0
        for (const tenant of directory.ListTenants())
        {
            if (tenant.ownerEmail === undefined || tenant.ownerPrincipalId === undefined)
            {
                continue
            }
            const existing = this.Get(TenantAccountIndex.IdOf(tenant.id, tenant.ownerPrincipalId))
            if (existing !== undefined && existing.email === TenantAccountIndex.Normalise(tenant.ownerEmail))
            {
                continue
            }
            await this.Record(tenant.id, tenant.ownerPrincipalId, tenant.ownerEmail)
            added++
        }
        return added
    }
}
