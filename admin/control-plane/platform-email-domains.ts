import { ConsoleAdvertRegistry, type ConsoleAdvertRecord, type IConsoleAdvertLookup } from './console-advert-registry.js'
import { ConsoleDomainApprovals } from './console-domain-approvals.js'
import { EmailDomainPolicy, InvalidEmailDomainError } from './email-domain-policy.js'
import { HiveConsoleSpecs } from './hive-console-spec.js'
import { UnknownTenantError, type PlatformDirectory } from './platform-directory.js'
import type { TenantRecord } from './platform-records.js'
import { EmailDomainsNotEditableError, type ITenantEmailDomains, type TenantEmailDomainsView } from './tenant-api/tenant-email-domains.js'

/** Where a tenant's email domains come from: its platform record (control-plane tenant) or its in-hive console's advert. */
export enum EmailDomainSource
{
    Tenant = 'tenant',
    Console = 'console',
}

/**
 * One domain of a tenant as the operator reviews it: whether an operator approved it, whether the tenant still claims it (its
 * advert or record lists it; an approved domain no longer claimed is kept listed so it can be revoked before a later claim
 * re-arms it), and which other tenants claim it too.
 */
export type EmailDomainApproval = { domain: string; approved: boolean; claimed: boolean; sharedWith: string[] }

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
 * Nobody's claim alone redirects an address: a claimed domain matches in discovery only once an operator approved it
 * (ConsoleDomainApprovals, the one store for both kinds of tenant; Approve / Revoke here). The domains an operator's save adds
 * to the record are approved on save; those the tenant Owner sets (in the console or on the tenant plane) wait for approval. "Claimed" domains,
 * used for `sharedWith` and the approval check, are a tenant's record domains (control-plane tenant) or all its advertised
 * domains (in-hive tenant), approved or not, so an operator sees a conflict before approving.
 */
export class PlatformEmailDomains implements ITenantEmailDomains
{
    private static readonly NotEditableMessage = "This tenant's console runs in its hive; its email domains are set there by the tenant Owner."
    private static readonly ApprovalsUnavailableMessage = 'Email domain approval is not available on this control plane.'
    private static readonly NotAdvertisedSuffix = " is not among the email domains this tenant's console reports, so there is nothing to approve."
    private static readonly NotInRecordSuffix = " is not among this tenant's email domains, so there is nothing to approve."

    public constructor(
        private readonly directory: PlatformDirectory,
        private readonly adverts: IConsoleAdvertLookup | undefined,
        private readonly approvals?: ConsoleDomainApprovals)
    {
    }

    /** True when one of the tenant's hives is set to run the tenant console. */
    public IsInHive(tenantId: string): boolean
    {
        return HiveConsoleSpecs.ConsoleHiveOf(this.directory.ListHives(tenantId)) !== undefined
    }

    /** undefined for an unknown tenant. */
    public Report(tenantId: string): TenantEmailDomainsReport | undefined
    {
        const tenant = this.directory.GetTenant(tenantId)
        if (tenant === undefined)
        {
            return undefined
        }
        const claims = this.ClaimsOfOthers(tenantId)
        const domains = [...this.ClaimedDomainsOf(tenant)].sort()
        const approved = this.ApprovedFor(tenantId)
        const claimed = new Set(domains)
        const approvals: EmailDomainApproval[] = [
            ...domains.map(domain => ({ domain, approved: approved.includes(domain), claimed: true, sharedWith: PlatformEmailDomains.SharedWith([domain], claims) })),
            ...approved.filter(d => !claimed.has(d)).map(domain => ({ domain, approved: true, claimed: false, sharedWith: PlatformEmailDomains.SharedWith([domain], claims) })),
        ]
        const sharedWith = PlatformEmailDomains.SharedWith(domains, claims)
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

    public For(tenantId: string): TenantEmailDomainsView
    {
        const tenant = this.directory.GetTenant(tenantId)
        if (tenant === undefined)
        {
            return { domains: [], editable: false, inHive: false, pending: [] }
        }
        return this.ViewOf(tenant)
    }

    /** The tenant Owner's write (the tenant plane): the record changes, and each domain not yet approved waits for an operator. */
    public async Set(tenantId: string, domains: unknown): Promise<TenantEmailDomainsView>
    {
        return this.ViewOf(await this.WriteRecord(tenantId, domains))
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
        const tenant = this.KnownTenant(tenantId)
        const normalised = EmailDomainPolicy.Normalise(domain)
        const refusal = EmailDomainPolicy.Check(normalised)
        if (refusal !== undefined)
        {
            throw new InvalidEmailDomainError(refusal)
        }
        if (!this.ClaimedDomainsOf(tenant).includes(normalised))
        {
            const suffix = this.IsInHive(tenantId) ? PlatformEmailDomains.NotAdvertisedSuffix : PlatformEmailDomains.NotInRecordSuffix
            throw new EmailDomainApprovalRefusedError(normalised + suffix)
        }
        await this.ApprovalStore().Approve(tenantId, normalised)
        return normalised
    }

    /**
     * Withdraws one domain's approval (a no-op when it was not approved) and answers it normalised. Allowed for any known tenant and
     * checked for shape only (EmailDomainPolicy.CheckSyntax: a well-formed name of at most 253 characters, else
     * InvalidEmailDomainError), so a stored approval the policy has since come to refuse can still be cleared while arbitrary text
     * never reaches the audit note.
     */
    public async Revoke(tenantId: string, domain: string): Promise<string>
    {
        this.KnownTenant(tenantId)
        const normalised = EmailDomainPolicy.Normalise(domain)
        const refusal = EmailDomainPolicy.CheckSyntax(normalised)
        if (refusal !== undefined)
        {
            throw new InvalidEmailDomainError(refusal)
        }
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

    private ViewOf(tenant: TenantRecord): TenantEmailDomainsView
    {
        const inHive = this.IsInHive(tenant.id)
        const domains = [...this.ClaimedDomainsOf(tenant)].sort()
        const effective = new Set(ConsoleDomainApprovals.EffectiveDomains(domains, this.ApprovedFor(tenant.id)))
        return { domains, editable: !inHive, inHive, pending: domains.filter(d => !effective.has(d)) }
    }

    private ApprovedFor(tenantId: string): readonly string[]
    {
        return this.approvals?.ApprovedFor(tenantId) ?? []
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

    /** The domains a tenant claims: its usable advert's (in-hive, approved or not) or its record's (control-plane tenant). */
    private ClaimedDomainsOf(tenant: TenantRecord): readonly string[]
    {
        if (this.IsInHive(tenant.id))
        {
            return this.AdvertOf(tenant.id)?.emailDomains ?? []
        }
        return PlatformEmailDomains.RecordDomainsOf(tenant)
    }

    /** Every other tenant's claimed domains, keyed by tenant id. */
    private ClaimsOfOthers(tenantId: string): ReadonlyMap<string, ReadonlySet<string>>
    {
        const claims = new Map<string, ReadonlySet<string>>()
        for (const other of this.directory.ListTenants())
        {
            if (other.id !== tenantId)
            {
                claims.set(other.id, new Set(this.ClaimedDomainsOf(other)))
            }
        }
        return claims
    }

    /** Sorted ids of the tenants in `claims` claiming any of `domains`. */
    private static SharedWith(domains: readonly string[], claims: ReadonlyMap<string, ReadonlySet<string>>): string[]
    {
        return [...claims].filter(([, claimed]) => domains.some(d => claimed.has(d))).map(([id]) => id).sort()
    }

    private static RecordDomainsOf(tenant: TenantRecord): string[]
    {
        return [...(tenant.emailDomains ?? [])]
    }
}
