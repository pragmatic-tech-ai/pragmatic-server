import { DomainApprovalState, DomainVerificationRecord } from './domain-verification-record.js'
import { EmailDomainPolicy } from './email-domain-policy.js'
import { JsonRecordStore } from './json-record-store.js'

/** One domain's DNS verification: the platform-issued token, whether its TXT record was seen at the last check, and when that was. */
export type DomainVerificationEntry = { token: string; verified: boolean; lastCheckedAt?: string }

/**
 * Where a tenant's email domains stand with the platform; the record id is the tenant id. `domains` = operator approvals,
 * `revoked` = operator revokes (they beat verification), `verifications` = tokens and check results keyed by normalised domain.
 * A record written before verification existed lacks the two optional fields and reads as having none.
 */
export type ConsoleDomainApprovalRecord = {
    id: string
    tenantId: string
    domains: string[]
    revoked?: string[]
    verifications?: Record<string, DomainVerificationEntry>
}

/**
 * A tenant's approved, revoked and verified domains, each normalised, deduped and sorted (StandingOf guarantees it): the input to
 * StateOf / EffectiveDomains, which bring any standing a caller builds into that shape before reading it.
 */
export type DomainStanding = { approved: readonly string[]; revoked: readonly string[]; verified: readonly string[] }

/**
 * Per-tenant email-domain standing, for in-hive and control-plane tenants alike: operator approvals, operator revokes and DNS TXT
 * verification tokens and results. Kept apart from the advert store (replaced on every advert) and from the tenant record (which
 * the tenant Owner may edit), so all three survive re-adverts and Owner edits. A domain only takes effect while the tenant also
 * claims it (EffectiveDomains). The store judges nothing: PlatformEmailDomains checks the policy before it approves.
 *
 * Every mutator reads the record, builds the new one and calls Put with no await before it, so each read-modify-stage is atomic
 * against the other mutators (Put stages synchronously). Only ForgetTenant removes a record.
 */
export class ConsoleDomainApprovals extends JsonRecordStore<ConsoleDomainApprovalRecord>
{
    public static readonly FileName = 'console-domain-approvals.json'
    private static readonly RootKey = 'approvals'
    private static readonly EffectiveStates: ReadonlySet<DomainApprovalState> = new Set([DomainApprovalState.Approved, DomainApprovalState.Verified])

    public constructor(filePath: string)
    {
        super(filePath, ConsoleDomainApprovals.RootKey)
    }

    /** The tenant's approved domains, sorted. */
    public ApprovedFor(tenantId: string): readonly string[]
    {
        return [...(this.Get(tenantId)?.domains ?? [])]
    }

    /** The tenant's revoked domains, sorted. */
    public RevokedFor(tenantId: string): readonly string[]
    {
        return [...(this.Get(tenantId)?.revoked ?? [])]
    }

    /** The domain's (normalised) verification entry, a copy; undefined when no token was issued for it. */
    public VerificationOf(tenantId: string, domain: string): DomainVerificationEntry | undefined
    {
        const entry = this.Get(tenantId)?.verifications?.[EmailDomainPolicy.Normalise(domain)]
        return entry === undefined ? undefined : { ...entry }
    }

    /**
     * The tenant's approvals, revokes and verified domains in one read, each normalised, deduped and sorted even when the stored
     * record is not (a hand-edited file), so StateOf and EffectiveDomains always read the one shape DomainStanding promises.
     */
    public StandingOf(tenantId: string): DomainStanding
    {
        const record = this.Get(tenantId)
        const verifications = Object.entries(record?.verifications ?? {})
        return {
            approved: EmailDomainPolicy.Distinct(record?.domains ?? []),
            revoked: EmailDomainPolicy.Distinct(record?.revoked ?? []),
            verified: EmailDomainPolicy.Distinct(verifications.filter(([, entry]) => entry.verified).map(([domain]) => domain)),
        }
    }

    /** Approves one domain (normalised) and clears its revoke. Idempotent. */
    public async Approve(tenantId: string, domain: string): Promise<void>
    {
        await this.ApproveAll(tenantId, [domain])
    }

    /** Approves several domains (normalised) and clears their revokes in one write; a no-op when nothing changes. */
    public async ApproveAll(tenantId: string, domains: readonly string[]): Promise<void>
    {
        const record = this.RecordOf(tenantId)
        const added = new Set(EmailDomainPolicy.Distinct(domains))
        const approved = EmailDomainPolicy.Distinct([...record.domains, ...added])
        const revoked = (record.revoked ?? []).filter(d => !added.has(d))
        if (approved.length === record.domains.length && revoked.length === (record.revoked ?? []).length)
        {
            return
        }
        await this.Put({ ...record, domains: approved, revoked })
    }

    /**
     * Withdraws one domain's approval (if any) and records a revoke for it, which beats verification until an operator approves
     * the domain again. The token and check result are kept. Idempotent.
     */
    public async Revoke(tenantId: string, domain: string): Promise<void>
    {
        const normalised = EmailDomainPolicy.Normalise(domain)
        const record = this.RecordOf(tenantId)
        const revoked = record.revoked ?? []
        if (revoked.includes(normalised) && !record.domains.includes(normalised))
        {
            return
        }
        await this.Put({ ...record, domains: record.domains.filter(d => d !== normalised), revoked: EmailDomainPolicy.Distinct([...revoked, normalised]) })
    }

    /** Issues a token for each domain (normalised) that has none, in one write; writes nothing when every domain has a token. */
    public async EnsureTokens(tenantId: string, domains: readonly string[]): Promise<void>
    {
        const record = this.RecordOf(tenantId)
        const verifications = { ...(record.verifications ?? {}) }
        let issued = false
        for (const domain of domains.map(d => EmailDomainPolicy.Normalise(d)))
        {
            if (verifications[domain] === undefined)
            {
                verifications[domain] = { token: DomainVerificationRecord.NewToken(), verified: false }
                issued = true
            }
        }
        if (!issued)
        {
            return
        }
        await this.Put({ ...record, verifications })
    }

    /**
     * Stores one check result for the domain (normalised). A no-op when the domain has no token, so a check finishing after
     * ForgetTenant never brings the record back. The caller records only definite answers: a failed lookup changes nothing.
     */
    public async RecordCheck(tenantId: string, domain: string, verified: boolean, checkedAt: string): Promise<void>
    {
        const normalised = EmailDomainPolicy.Normalise(domain)
        const record = this.Get(tenantId)
        const entry = record?.verifications?.[normalised]
        if (record === undefined || entry === undefined)
        {
            return
        }
        await this.Put({ ...record, verifications: { ...record.verifications, [normalised]: { token: entry.token, verified, lastCheckedAt: checkedAt } } })
    }

    /** Every verified domain with its token, sorted by tenant id, then domain: what the daily re-check looks up. */
    public VerifiedEntries(): Array<{ tenantId: string; domain: string; token: string }>
    {
        const entries: Array<{ tenantId: string; domain: string; token: string }> = []
        for (const record of this.Values())
        {
            for (const [domain, entry] of Object.entries(record.verifications ?? {}))
            {
                if (entry.verified)
                {
                    entries.push({ tenantId: record.tenantId, domain, token: entry.token })
                }
            }
        }
        return entries.sort((a, b) => ConsoleDomainApprovals.Compare(a.tenantId, b.tenantId) || ConsoleDomainApprovals.Compare(a.domain, b.domain))
    }

    public async ForgetTenant(tenantId: string): Promise<void>
    {
        await this.Remove(tenantId)
    }

    /**
     * One domain's state, checked in order: revoked, approved, verified and uncontested, verified and contested (another tenant
     * claims it too), else pending. A revoke beats both an approval and a verification.
     */
    public static StateOf(standing: DomainStanding, domain: string, contested: boolean): DomainApprovalState
    {
        return ConsoleDomainApprovals.StateIn(ConsoleDomainApprovals.Normalised(standing), EmailDomainPolicy.Normalise(domain), contested)
    }

    /**
     * The one rule for which domains discovery may use for a tenant: those it claims (its usable advert's for an in-hive tenant,
     * its record's for a control-plane tenant) that are operator-approved, or verified and claimed by no other tenant
     * (`contested`, normalised), and not revoked. Sorted, deduped, normalised.
     */
    public static EffectiveDomains(claimed: readonly string[], standing: DomainStanding, contested: ReadonlySet<string>): string[]
    {
        const normalised = ConsoleDomainApprovals.Normalised(standing)
        return EmailDomainPolicy.Distinct(claimed)
            .filter(d => ConsoleDomainApprovals.EffectiveStates.has(ConsoleDomainApprovals.StateIn(normalised, d, contested.has(d))))
    }

    /** The tenant's record (a copy), or an empty one not yet stored. */
    private RecordOf(tenantId: string): ConsoleDomainApprovalRecord
    {
        return this.Get(tenantId) ?? { id: tenantId, tenantId, domains: [] }
    }

    /** The precedence table over a standing and domain already normalised. */
    private static StateIn(standing: DomainStanding, domain: string, contested: boolean): DomainApprovalState
    {
        if (standing.revoked.includes(domain))
        {
            return DomainApprovalState.Revoked
        }
        if (standing.approved.includes(domain))
        {
            return DomainApprovalState.Approved
        }
        if (standing.verified.includes(domain))
        {
            return contested ? DomainApprovalState.VerifiedContested : DomainApprovalState.Verified
        }
        return DomainApprovalState.Pending
    }

    /** The standing in the one shape DomainStanding promises (normalised, deduped, sorted), whatever its caller passed. */
    private static Normalised(standing: DomainStanding): DomainStanding
    {
        return {
            approved: EmailDomainPolicy.Distinct(standing.approved),
            revoked: EmailDomainPolicy.Distinct(standing.revoked),
            verified: EmailDomainPolicy.Distinct(standing.verified),
        }
    }

    /** Ordinal comparison, matching the default Array.sort used for every domain list here. */
    private static Compare(a: string, b: string): number
    {
        return a < b ? -1 : a > b ? 1 : 0
    }
}
