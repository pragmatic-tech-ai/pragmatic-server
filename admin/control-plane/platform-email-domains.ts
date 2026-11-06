import { AuditThrottle } from './audit-throttle.js'
import { ConsoleAdvertRegistry, type ConsoleAdvertRecord, type IConsoleAdvertLookup } from './console-advert-registry.js'
import { ConsoleDomainApprovals, type DomainStanding } from './console-domain-approvals.js'
import { DomainClaims } from './domain-claims.js'
import { DomainVerificationRecord, type DomainApprovalState, type DomainVerificationAnswer, type DomainVerificationView } from './domain-verification-record.js'
import { EmailDomainPolicy, InvalidEmailDomainError } from './email-domain-policy.js'
import { HiveConsoleSpecs } from './hive-console-spec.js'
import { UnknownTenantError, type PlatformDirectory } from './platform-directory.js'
import type { TenantRecord } from './platform-records.js'
import {
    DomainNotClaimedError, DomainVerificationUnavailableError, DomainVerifyThrottledError, EmailDomainsNotEditableError, type ITenantEmailDomains,
    type TenantEmailDomainsView,
} from './tenant-api/tenant-email-domains.js'
import { DomainCheck, type DomainTxtVerifier } from './txt-resolver.js'

/** Where a tenant's email domains come from: its platform record (control-plane tenant) or its in-hive console's advert. */
export enum EmailDomainSource
{
    Tenant = 'tenant',
    Console = 'console',
}

/**
 * One domain of a tenant as the operator reviews it: whether an operator approved it, whether the tenant still claims it (its
 * advert or record lists it; an approved domain no longer claimed is kept listed so it can be revoked before a later claim
 * re-arms it), which other tenants claim it too, its state (ConsoleDomainApprovals.StateOf) and whether its TXT record was seen
 * at the last check. `recordName` / `recordValue` (the TXT record to publish) are present when a token was issued for it.
 */
export type EmailDomainApproval = {
    domain: string
    approved: boolean
    claimed: boolean
    sharedWith: string[]
    state: DomainApprovalState
    verified: boolean
    lastCheckedAt?: string
    recordName?: string
    recordValue?: string
}

/**
 * The operator's view of a tenant's email domains. `sharedWith` = sorted ids of the other tenants claiming any of these domains.
 * `approvals`: one entry per claimed domain in `domains` order, then each approved domain no longer claimed, sorted.
 */
export type TenantEmailDomainsReport = {
    tenantId: string
    domains: string[]
    source: EmailDomainSource
    editable: boolean
    reportedAt?: string
    sharedWith: string[]
    approvals: EmailDomainApproval[]
}

/** An operator approval that cannot apply (the tenant does not claim that domain, or there is no approval store); maps to 409. */
export class EmailDomainApprovalRefusedError extends Error
{
    private static readonly ErrorName = 'EmailDomainApprovalRefusedError'

    public constructor(message: string)
    {
        super(message)
        this.name = EmailDomainApprovalRefusedError.ErrorName
    }
}

/**
 * The control plane's email domains per tenant, for the operator routes and the control-plane tenant plane.
 *
 * A control-plane tenant's domains are its record's `emailDomains`, editable here by the operator (SetAsOperator) and by the
 * tenant Owner through the tenant plane (Set). An in-hive tenant (a hive of it is set to run the console) gets its domains only
 * from its usable console advert (ConsoleAdvertRegistry.UsableFor), read-only here: the tenant Owner sets them in the console.
 * Its record's domains are ignored while the console is set, and advert domains are never copied back into the record (that
 * would let a hive write platform records). So after the console is removed (its advert forgotten), the tenant reads as a
 * control-plane tenant again and its OLD record domains (those seeded into the console at install) are claimed again (effective
 * where approved). The Owner's in-hive edits are ignored by the control plane until the console is reinstalled: they stay in
 * `email-domains.json` on the console's retained data volume, so a reinstall brings them back in its first advert (and those an
 * operator approved before match again at once, since approvals are kept per tenant). Accepted.
 *
 * Nobody's claim alone redirects an address. A claimed domain matches in discovery once an operator approved it, or once its DNS
 * TXT record is verified (VerifyDomain) and no other tenant claims it; an operator's revoke beats both until the operator approves
 * it again (ConsoleDomainApprovals.EffectiveDomains over ConsoleDomainApprovals, the one store for both kinds of tenant). The
 * domains an operator's save adds to the record are approved on save; those the tenant Owner sets (in the console or on the
 * tenant plane) wait for approval or verification. Which tenant claims what comes from one DomainClaims per public call, so the
 * claimed check, `sharedWith` and "contested" of one answer always agree; an operator sees a conflict before approving.
 */
export class PlatformEmailDomains implements ITenantEmailDomains
{
    private static readonly NotEditableMessage = "This tenant's console runs in its hive; its email domains are set there by the tenant Owner."
    private static readonly ApprovalsUnavailableMessage = 'Email domain approval is not available on this control plane.'
    private static readonly NotAdvertisedSuffix = " is not among the email domains this tenant's console reports, so there is nothing to approve."
    private static readonly NotInRecordSuffix = " is not among this tenant's email domains, so there is nothing to approve."
    private static readonly NotClaimedSuffix = " is not among this tenant's email domains, so there is nothing to verify."
    private static readonly VerificationUnavailableMessage = 'DNS verification is not available on this control plane.'
    private static readonly ThrottledMessage = 'Too many verification attempts for this tenant. Try again in a few minutes.'
    private static readonly LookupIncompletePrefix = 'The DNS lookup for '
    private static readonly LookupIncompleteSuffix = ' did not complete. Try again later.'
    /**
     * The operator's verify throttles under this prefix plus the tenant id, apart from the tenant's own key (the tenant plane and
     * the in-hive console share the bare tenant id), so a tenant spamming Verify cannot lock the operator out.
     */
    private static readonly OperatorThrottleKeyPrefix = 'operator:'
    /** Verification lookups per throttle key (tenant side, operator side): 10 in a 15-minute window, then a 15-minute lockout. */
    private static readonly VerifyMaxHits = 10
    private static readonly VerifyWindowMs = 15 * 60 * 1000
    private static readonly VerifyLockoutMs = 15 * 60 * 1000
    private static readonly NoStanding: DomainStanding = { approved: [], revoked: [], verified: [] }

    public constructor(
        private readonly directory: PlatformDirectory,
        private readonly adverts: IConsoleAdvertLookup | undefined,
        private readonly approvals?: ConsoleDomainApprovals,
        private readonly verifier?: DomainTxtVerifier,
        private readonly throttle: AuditThrottle = new AuditThrottle({
            maxHits: PlatformEmailDomains.VerifyMaxHits, windowMs: PlatformEmailDomains.VerifyWindowMs, lockoutMs: PlatformEmailDomains.VerifyLockoutMs,
        }),
        private readonly now: () => Date = () => new Date())
    {
    }

    /** True when one of the tenant's hives is set to run the tenant console. */
    public IsInHive(tenantId: string): boolean
    {
        return HiveConsoleSpecs.ConsoleHiveOf(this.directory.ListHives(tenantId)) !== undefined
    }

    /** undefined for an unknown tenant. Issues a verification token for each claimed domain that has none first. */
    public async Report(tenantId: string): Promise<TenantEmailDomainsReport | undefined>
    {
        if (this.directory.GetTenant(tenantId) === undefined)
        {
            return undefined
        }
        const claims = this.Claims()
        const domains = [...claims.ClaimedBy(tenantId)]
        await this.EnsureTokens(tenantId, domains)
        const standing = this.StandingOf(tenantId)
        const claimed = new Set(domains)
        const approvals: EmailDomainApproval[] = [
            ...domains.map(domain => this.RowOf(tenantId, domain, true, standing, claims)),
            ...standing.approved.filter(d => !claimed.has(d)).map(domain => this.RowOf(tenantId, domain, false, standing, claims)),
        ]
        const sharedWith = [...new Set(domains.flatMap(d => claims.OthersClaiming(tenantId, d)))].sort()
        if (!this.IsInHive(tenantId))
        {
            return { tenantId, domains, source: EmailDomainSource.Tenant, editable: true, sharedWith, approvals }
        }
        const report: TenantEmailDomainsReport = { tenantId, domains, source: EmailDomainSource.Console, editable: false, sharedWith, approvals }
        const advert = this.AdvertOf(tenantId)
        if (advert !== undefined)
        {
            report.reportedAt = advert.reportedAt
        }
        return report
    }

    /** The tenant plane's view; issues a verification token for each claimed domain that has none first. */
    public async For(tenantId: string): Promise<TenantEmailDomainsView>
    {
        if (this.directory.GetTenant(tenantId) === undefined)
        {
            return { domains: [], editable: false, inHive: false, pending: [], verifications: [] }
        }
        return await this.ViewOf(tenantId)
    }

    /** The tenant Owner's write (the tenant plane): the record changes, and each new domain waits for approval or verification. */
    public async Set(tenantId: string, domains: unknown): Promise<TenantEmailDomainsView>
    {
        await this.WriteRecord(tenantId, domains)
        return await this.ViewOf(tenantId)
    }

    /** VerifyDomain, then the updated tenant view; throws like VerifyDomain. */
    public async Verify(tenantId: string, domain: string): Promise<TenantEmailDomainsView>
    {
        await this.VerifyDomain(tenantId, domain)
        return await this.For(tenantId)
    }

    /**
     * Looks up one claimed domain's TXT record now and stores the result. Throws UnknownTenantError, InvalidEmailDomainError (not
     * a well-formed name), DomainNotClaimedError, DomainVerificationUnavailableError (no verifier or approval store, or the lookup
     * did not complete: nothing is stored then) or DomainVerifyThrottledError (more than VerifyMaxHits tenant-side lookups for this
     * tenant in the window; refused before any lookup). The token is always the stored one, never a client's. The tenant's side:
     * the tenant plane and the in-hive console share this tenant's throttle key.
     */
    public async VerifyDomain(tenantId: string, domain: string): Promise<DomainVerificationAnswer>
    {
        return await this.VerifyThrottled(tenantId, domain, tenantId)
    }

    /** VerifyDomain for the operator (the operator route): the same checks and limit under the operator's own throttle key. */
    public async VerifyDomainAsOperator(tenantId: string, domain: string): Promise<DomainVerificationAnswer>
    {
        return await this.VerifyThrottled(tenantId, domain, PlatformEmailDomains.OperatorThrottleKeyPrefix + tenantId)
    }

    private async VerifyThrottled(tenantId: string, domain: string, throttleKey: string): Promise<DomainVerificationAnswer>
    {
        const P = PlatformEmailDomains
        this.KnownTenant(tenantId)
        const normalised = P.WellFormed(domain)
        const claims = this.Claims()
        if (!claims.ClaimedBy(tenantId).includes(normalised))
        {
            throw new DomainNotClaimedError(normalised + P.NotClaimedSuffix)
        }
        if (this.verifier === undefined || this.approvals === undefined)
        {
            throw new DomainVerificationUnavailableError(P.VerificationUnavailableMessage)
        }
        // AuditThrottle locks inside RecordHit once hits exceed maxHits, so checking again after the hit admits exactly
        // VerifyMaxHits lookups per window.
        if (!this.throttle.CheckAllowed(throttleKey).allowed)
        {
            throw new DomainVerifyThrottledError(P.ThrottledMessage)
        }
        this.throttle.RecordHit(throttleKey)
        if (!this.throttle.CheckAllowed(throttleKey).allowed)
        {
            throw new DomainVerifyThrottledError(P.ThrottledMessage)
        }
        await this.approvals.EnsureTokens(tenantId, [normalised])
        const token = this.approvals.VerificationOf(tenantId, normalised)?.token
        if (token === undefined)
        {
            // Only a concurrent ForgetTenant drops the token EnsureTokens just issued: the tenant is gone.
            throw new UnknownTenantError(tenantId)
        }
        const check = await this.verifier.Check(normalised, token)
        if (check === DomainCheck.Failed)
        {
            throw new DomainVerificationUnavailableError(P.LookupIncompletePrefix + DomainVerificationRecord.NameFor(normalised) + P.LookupIncompleteSuffix)
        }
        await this.approvals.RecordCheck(tenantId, normalised, check === DomainCheck.Verified, this.now().toISOString())
        const answer = this.AnswerOf(tenantId, normalised, this.StandingOf(tenantId), claims.OthersClaiming(tenantId, normalised).length > 0)
        if (answer === undefined)
        {
            // Only ForgetTenant drops the entry between the check and here: the tenant is gone.
            throw new UnknownTenantError(tenantId)
        }
        return answer
    }

    /**
     * Issues a token for each of `domains` (normalised) that has none and answers one entry per domain, in the given order, with
     * its state against the current claims. None without an approval store (there are no tokens then). Throws UnknownTenantError
     * or InvalidEmailDomainError (any domain that is not a well-formed name) before anything is written.
     */
    public async AnswersFor(tenantId: string, domains: readonly string[]): Promise<DomainVerificationAnswer[]>
    {
        this.KnownTenant(tenantId)
        const normalised = domains.map(d => PlatformEmailDomains.WellFormed(d))
        if (this.approvals === undefined)
        {
            return []
        }
        await this.approvals.EnsureTokens(tenantId, normalised)
        const claims = this.Claims()
        const standing = this.StandingOf(tenantId)
        return normalised
            .map(d => this.AnswerOf(tenantId, d, standing, claims.OthersClaiming(tenantId, d).length > 0))
            .filter((a): a is DomainVerificationAnswer => a !== undefined)
    }

    /**
     * The operator's write: the record changes and each domain this write ADDS to the record is approved (an operator typed it,
     * so nobody else must). Domains already on the record keep their approval state, so saving the whole list never approves an
     * Owner's pending domain as a side effect (that takes an explicit Approve). Answers the domains approved on save, sorted.
     */
    public async SetAsOperator(tenantId: string, domains: unknown): Promise<string[]>
    {
        const before = new Set(PlatformEmailDomains.RecordDomainsOf(this.KnownTenant(tenantId)))
        const updated = await this.WriteRecord(tenantId, domains)
        const added = PlatformEmailDomains.RecordDomainsOf(updated).filter(d => !before.has(d)).sort()
        if (this.approvals === undefined)
        {
            return []
        }
        await this.approvals.ApproveAll(tenantId, added)
        return added
    }

    /**
     * Approves one domain the tenant claims (its console advertises it, or its record holds it) and answers it normalised. Throws
     * UnknownTenantError, InvalidEmailDomainError (the policy refuses it) or EmailDomainApprovalRefusedError (not claimed, or no
     * approval store). The policy check here is the only one on the approve path.
     */
    public async Approve(tenantId: string, domain: string): Promise<string>
    {
        this.KnownTenant(tenantId)
        const normalised = EmailDomainPolicy.Normalise(domain)
        const refusal = EmailDomainPolicy.Check(normalised)
        if (refusal !== undefined)
        {
            throw new InvalidEmailDomainError(refusal)
        }
        if (!this.Claims().ClaimedBy(tenantId).includes(normalised))
        {
            const suffix = this.IsInHive(tenantId) ? PlatformEmailDomains.NotAdvertisedSuffix : PlatformEmailDomains.NotInRecordSuffix
            throw new EmailDomainApprovalRefusedError(normalised + suffix)
        }
        await this.ApprovalStore().Approve(tenantId, normalised)
        return normalised
    }

    /**
     * Withdraws one domain's approval (if any), stores a revoke for it (which beats verification until an operator approves it
     * again; stored even when it was never approved) and answers it normalised. Allowed for any known tenant and
     * checked for shape only (EmailDomainPolicy.CheckSyntax: a well-formed name of at most 253 characters, else
     * InvalidEmailDomainError), so a stored approval the policy has since come to refuse can still be cleared while arbitrary text
     * never reaches the audit note.
     */
    public async Revoke(tenantId: string, domain: string): Promise<string>
    {
        this.KnownTenant(tenantId)
        const normalised = PlatformEmailDomains.WellFormed(domain)
        await this.ApprovalStore().Revoke(tenantId, normalised)
        return normalised
    }

    private KnownTenant(tenantId: string): TenantRecord
    {
        const tenant = this.directory.GetTenant(tenantId)
        if (tenant === undefined)
        {
            throw new UnknownTenantError(tenantId)
        }
        return tenant
    }

    /** Writes a control-plane tenant's record domains (parsed by the policy); refuses an in-hive tenant. */
    private async WriteRecord(tenantId: string, domains: unknown): Promise<TenantRecord>
    {
        this.KnownTenant(tenantId)
        if (this.IsInHive(tenantId))
        {
            throw new EmailDomainsNotEditableError(PlatformEmailDomains.NotEditableMessage)
        }
        return await this.directory.SetTenantEmailDomains(tenantId, domains)
    }

    /** The view of a known tenant; `pending` = its claimed domains not effective (ConsoleDomainApprovals.EffectiveDomains). */
    private async ViewOf(tenantId: string): Promise<TenantEmailDomainsView>
    {
        const claims = this.Claims()
        const inHive = this.IsInHive(tenantId)
        const domains = [...claims.ClaimedBy(tenantId)]
        await this.EnsureTokens(tenantId, domains)
        const standing = this.StandingOf(tenantId)
        const contested = claims.ContestedFor(tenantId)
        const effective = new Set(ConsoleDomainApprovals.EffectiveDomains(domains, standing, contested))
        const verifications: DomainVerificationView[] = []
        for (const domain of domains)
        {
            const answer = this.AnswerOf(tenantId, domain, standing, contested.has(domain))
            if (answer !== undefined)
            {
                verifications.push(DomainVerificationRecord.ViewOf(answer))
            }
        }
        return { domains, editable: !inHive, inHive, pending: domains.filter(d => !effective.has(d)), verifications }
    }

    /** One operator row; the record fields only when a token was issued for the domain. */
    private RowOf(tenantId: string, domain: string, claimed: boolean, standing: DomainStanding, claims: DomainClaims): EmailDomainApproval
    {
        const sharedWith = claims.OthersClaiming(tenantId, domain)
        const entry = this.approvals?.VerificationOf(tenantId, domain)
        const row: EmailDomainApproval = {
            domain, approved: standing.approved.includes(domain), claimed, sharedWith,
            state: ConsoleDomainApprovals.StateOf(standing, domain, sharedWith.length > 0), verified: entry?.verified ?? false,
        }
        if (entry === undefined)
        {
            return row
        }
        if (entry.lastCheckedAt !== undefined)
        {
            row.lastCheckedAt = entry.lastCheckedAt
        }
        row.recordName = DomainVerificationRecord.NameFor(domain)
        row.recordValue = DomainVerificationRecord.ValueFor(entry.token)
        return row
    }

    /** The domain's verification answer, or undefined when no token was issued for it. */
    private AnswerOf(tenantId: string, domain: string, standing: DomainStanding, contested: boolean): DomainVerificationAnswer | undefined
    {
        const entry = this.approvals?.VerificationOf(tenantId, domain)
        if (entry === undefined)
        {
            return undefined
        }
        const answer: DomainVerificationAnswer = { domain, token: entry.token, verified: entry.verified, state: ConsoleDomainApprovals.StateOf(standing, domain, contested) }
        if (entry.lastCheckedAt !== undefined)
        {
            answer.lastCheckedAt = entry.lastCheckedAt
        }
        return answer
    }

    /** Issues the missing tokens; nothing without an approval store. */
    private async EnsureTokens(tenantId: string, domains: readonly string[]): Promise<void>
    {
        await this.approvals?.EnsureTokens(tenantId, domains)
    }

    private StandingOf(tenantId: string): DomainStanding
    {
        return this.approvals?.StandingOf(tenantId) ?? PlatformEmailDomains.NoStanding
    }

    /** Every tenant's claim, read now: one per public call so all of that call's answers agree. */
    private Claims(): DomainClaims
    {
        return DomainClaims.Collect(this.directory, this.adverts)
    }

    private ApprovalStore(): ConsoleDomainApprovals
    {
        if (this.approvals === undefined)
        {
            throw new EmailDomainApprovalRefusedError(PlatformEmailDomains.ApprovalsUnavailableMessage)
        }
        return this.approvals
    }

    private AdvertOf(tenantId: string): ConsoleAdvertRecord | undefined
    {
        return this.adverts === undefined ? undefined : ConsoleAdvertRegistry.UsableFor(this.adverts, tenantId, this.directory.ListHives(tenantId))
    }

    /** The domain normalised; throws InvalidEmailDomainError when it is not a well-formed name (EmailDomainPolicy.CheckSyntax). */
    private static WellFormed(domain: string): string
    {
        const normalised = EmailDomainPolicy.Normalise(domain)
        const refusal = EmailDomainPolicy.CheckSyntax(normalised)
        if (refusal !== undefined)
        {
            throw new InvalidEmailDomainError(refusal)
        }
        return normalised
    }

    private static RecordDomainsOf(tenant: TenantRecord): string[]
    {
        return [...(tenant.emailDomains ?? [])]
    }
}
