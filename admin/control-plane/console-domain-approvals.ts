import { EmailDomainPolicy, InvalidEmailDomainError } from './email-domain-policy.js'
import { JsonRecordStore } from './json-record-store.js'

/** The email domains an operator has approved for one tenant; the record id is the tenant id. */
export type ConsoleDomainApprovalRecord = { id: string; tenantId: string; domains: string[] }

/**
 * Operator-approved email domains per tenant. Kept apart from the advert store (which is replaced on every
 * advert) so an approval survives re-adverts; a domain only takes effect while it is also in the advert.
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

    /** Approves one domain (normalised); throws InvalidEmailDomainError when the policy refuses it. Idempotent. */
    public async Approve(tenantId: string, domain: string): Promise<void>
    {
        const normalised = EmailDomainPolicy.Normalise(domain)
        const refusal = EmailDomainPolicy.Check(normalised)
        if (refusal !== undefined)
        {
            throw new InvalidEmailDomainError(refusal)
        }
        const current = this.ApprovedFor(tenantId)
        if (current.includes(normalised))
        {
            return
        }
        await this.Put({ id: tenantId, tenantId, domains: [...current, normalised].sort() })
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

    /** The domains discovery may use for an in-hive tenant: advertised AND approved (sorted, deduped). */
    public static EffectiveDomains(advertised: readonly string[], approved: readonly string[]): string[]
    {
        const allowed = new Set(approved.map(d => EmailDomainPolicy.Normalise(d)))
        return [...new Set(advertised.map(d => EmailDomainPolicy.Normalise(d)))].filter(d => allowed.has(d)).sort()
    }
}
