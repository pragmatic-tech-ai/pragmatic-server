import { EmailDomainPolicy } from './email-domain-policy.js'
import { JsonRecordStore } from './json-record-store.js'

/** The email domains an operator has approved for one tenant; the record id is the tenant id. */
export type ConsoleDomainApprovalRecord = { id: string; tenantId: string; domains: string[] }

/**
 * Operator-approved email domains per tenant, for in-hive and control-plane tenants alike: the one approval store. Kept apart from
 * the advert store (replaced on every advert) and from the tenant record (which the tenant Owner may edit), so an approval
 * survives re-adverts and Owner edits; a domain only takes effect while the tenant also claims it (EffectiveDomains).
 * The store judges nothing: PlatformEmailDomains checks the policy before it approves.
 */
export class ConsoleDomainApprovals extends JsonRecordStore<ConsoleDomainApprovalRecord>
{
    public static readonly FileName = 'console-domain-approvals.json'
    private static readonly RootKey = 'approvals'

    public constructor(filePath: string)
    {
        super(filePath, ConsoleDomainApprovals.RootKey)
    }

    /** The tenant's approved domains, sorted. */
    public ApprovedFor(tenantId: string): readonly string[]
    {
        return [...(this.Get(tenantId)?.domains ?? [])]
    }

    /** Approves one domain (normalised). Idempotent. */
    public async Approve(tenantId: string, domain: string): Promise<void>
    {
        await this.ApproveAll(tenantId, [domain])
    }

    /** Approves several domains (normalised) in one write; a no-op when all are approved already. */
    public async ApproveAll(tenantId: string, domains: readonly string[]): Promise<void>
    {
        const current = this.ApprovedFor(tenantId)
        const merged = [...new Set([...current, ...domains.map(d => EmailDomainPolicy.Normalise(d))])].sort()
        if (merged.length === current.length)
        {
            return
        }
        await this.Put({ id: tenantId, tenantId, domains: merged })
    }

    /** Withdraws one domain's approval; a no-op when it was not approved. */
    public async Revoke(tenantId: string, domain: string): Promise<void>
    {
        const normalised = EmailDomainPolicy.Normalise(domain)
        const current = this.ApprovedFor(tenantId)
        if (!current.includes(normalised))
        {
            return
        }
        const remaining = current.filter(d => d !== normalised)
        if (remaining.length === 0)
        {
            await this.Remove(tenantId)
            return
        }
        await this.Put({ id: tenantId, tenantId, domains: remaining })
    }

    public async ForgetTenant(tenantId: string): Promise<void>
    {
        await this.Remove(tenantId)
    }

    /**
     * The one rule for which domains discovery may use for a tenant: those it claims (its usable advert's for an in-hive tenant,
     * its record's for a control-plane tenant) that are also approved. Sorted, deduped, normalised.
     */
    public static EffectiveDomains(claimed: readonly string[], approved: readonly string[]): string[]
    {
        const allowed = new Set(approved.map(d => EmailDomainPolicy.Normalise(d)))
        return [...new Set(claimed.map(d => EmailDomainPolicy.Normalise(d)))].filter(d => allowed.has(d)).sort()
    }
}
