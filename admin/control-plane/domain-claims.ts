import { ConsoleAdvertRegistry, type IConsoleAdvertLookup } from './console-advert-registry.js'
import { EmailDomainPolicy } from './email-domain-policy.js'
import { HiveConsoleSpecs } from './hive-console-spec.js'
import type { HiveRecord, TenantRecord } from './platform-records.js'

/** The directory reads DomainClaims needs: every tenant, and each tenant's hives. */
export interface IDomainClaimDirectory
{
    ListTenants(): readonly TenantRecord[]
    ListHives(tenantId: string): readonly HiveRecord[]
}

/**
 * Which tenants claim which email domains, read once from the directory and the adverts. The one claim rule: an in-hive tenant
 * (one of its hives is set to run the console) claims its usable advert's domains (ConsoleAdvertRegistry.UsableFor), approved or
 * not, and none without a usable advert; any other tenant claims its record's domains. Domains are normalised. A claimed domain is
 * contested for a tenant when any other tenant claims it too; a contested verified domain does not take effect on its own.
 */
export class DomainClaims
{
    private static readonly None: readonly string[] = []

    private constructor(private readonly claims: ReadonlyMap<string, readonly string[]>)
    {
    }

    /** Reads every tenant's claim now; build a fresh one per public call so all its answers agree. */
    public static Collect(directory: IDomainClaimDirectory, adverts: IConsoleAdvertLookup | undefined): DomainClaims
    {
        const claims = new Map<string, readonly string[]>()
        for (const tenant of directory.ListTenants())
        {
            claims.set(tenant.id, DomainClaims.ClaimOf(tenant, directory.ListHives(tenant.id), adverts))
        }
        return new DomainClaims(claims)
    }

    /** The tenant's claimed domains, normalised, deduped and sorted; none for an unknown tenant. */
    public ClaimedBy(tenantId: string): readonly string[]
    {
        return [...(this.claims.get(tenantId) ?? DomainClaims.None)]
    }

    /** Sorted ids of the tenants other than `tenantId` that claim `domain` (normalised). */
    public OthersClaiming(tenantId: string, domain: string): string[]
    {
        const normalised = EmailDomainPolicy.Normalise(domain)
        return [...this.claims].filter(([id, claimed]) => id !== tenantId && claimed.includes(normalised)).map(([id]) => id).sort()
    }

    /** The tenant's claimed domains that another tenant claims too. */
    public ContestedFor(tenantId: string): ReadonlySet<string>
    {
        return new Set(this.ClaimedBy(tenantId).filter(d => this.OthersClaiming(tenantId, d).length > 0))
    }

    private static ClaimOf(tenant: TenantRecord, hives: readonly HiveRecord[], adverts: IConsoleAdvertLookup | undefined): readonly string[]
    {
        if (HiveConsoleSpecs.ConsoleHiveOf(hives) === undefined)
        {
            return DomainClaims.Normalised(tenant.emailDomains ?? DomainClaims.None)
        }
        const advert = adverts === undefined ? undefined : ConsoleAdvertRegistry.UsableFor(adverts, tenant.id, hives)
        return DomainClaims.Normalised(advert?.emailDomains ?? DomainClaims.None)
    }

    private static Normalised(domains: readonly string[]): readonly string[]
    {
        return [...new Set(domains.map(d => EmailDomainPolicy.Normalise(d)))].sort()
    }
}
