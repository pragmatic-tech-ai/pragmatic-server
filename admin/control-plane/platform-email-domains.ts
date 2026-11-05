import { ConsoleAdvertRegistry, type ConsoleAdvertRecord, type IConsoleAdvertLookup } from './console-advert-registry.js'
import type { ConsoleDomainApprovals } from './console-domain-approvals.js'
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

/** One domain an in-hive console advertises: whether an operator approved it, and which other tenants claim it too. */
export type EmailDomainApproval = { domain: string; approved: boolean; sharedWith: string[] }

/**
 * The operator's view of a tenant's email domains. `sharedWith` = sorted ids of the other tenants claiming any of these domains.
 * `approvals` is present only for an in-hive tenant (source Console): one entry per advertised domain, in `domains` order.
 */
export type TenantEmailDomainsReport = {
    tenantId: string
    domains: string[]
    source: EmailDomainSource
    editable: boolean
    reportedAt?: string
    sharedWith: string[]
    approvals?: EmailDomainApproval[]
}

/** An operator approval that cannot apply (the tenant is not in-hive, or its console does not report that domain); maps to 409. */
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
 * A control-plane tenant's domains are its record's `emailDomains`, editable here. An in-hive tenant (a hive of it is set to run the
 * console) gets its domains only from its usable console advert (ConsoleAdvertRegistry.UsableFor), read-only here: the tenant Owner
 * sets them in the console. Its record's domains are ignored while the console is set, and advert domains are never copied back into
 * the record (that would let a hive write platform records). So after the console is removed (its advert forgotten), the tenant reads
 * as a control-plane tenant again and its OLD record domains (those seeded into the console at install) become effective again; the
 * Owner's in-hive edits are lost. Accepted.
 *
 * An advertised domain matches in discovery only once an operator approved it (ConsoleDomainApprovals; Approve / Revoke here).
 * "Claimed" domains, used for `sharedWith`, are a tenant's record domains (control-plane tenant) or all its advertised domains,
 * approved or not (in-hive tenant), so an operator sees a conflict before approving.
 */
export class PlatformEmailDomains implements ITenantEmailDomains
{
    private static readonly NotEditableMessage = "This tenant's console runs in its hive; its email domains are set there by the tenant Owner."
    private static readonly NotInHiveMessage = "This tenant's console runs on the control plane; its email domains take effect without approval."
    private static readonly ApprovalsUnavailableMessage = 'Email domain approval is not available on this control plane.'
    private static readonly NotAdvertisedSuffix = " is not among the email domains this tenant's console reports, so there is nothing to approve."

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
        if (!this.IsInHive(tenantId))
        {
            const domains = PlatformEmailDomains.RecordDomainsOf(tenant)
            return { tenantId, domains, source: EmailDomainSource.Tenant, editable: true, sharedWith: PlatformEmailDomains.SharedWith(domains, claims) }
        }
        const advert = this.AdvertOf(tenantId)
        const domains = advert === undefined ? [] : [...advert.emailDomains].sort()
        const approved = new Set(this.approvals?.ApprovedFor(tenantId) ?? [])
        const report: TenantEmailDomainsReport = {
            tenantId, domains, source: EmailDomainSource.Console, editable: false, sharedWith: PlatformEmailDomains.SharedWith(domains, claims),
            approvals: domains.map(domain => ({ domain, approved: approved.has(domain), sharedWith: PlatformEmailDomains.SharedWith([domain], claims) })),
        }
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
            return { domains: [], editable: false, inHive: false }
        }
        if (this.IsInHive(tenantId))
        {
            return { domains: [...(this.AdvertOf(tenantId)?.emailDomains ?? [])].sort(), editable: false, inHive: true }
        }
        return { domains: PlatformEmailDomains.RecordDomainsOf(tenant), editable: true, inHive: false }
    }

    public async Set(tenantId: string, domains: unknown): Promise<TenantEmailDomainsView>
    {
        if (this.directory.GetTenant(tenantId) === undefined)
        {
            throw new UnknownTenantError(tenantId)
        }
        if (this.IsInHive(tenantId))
        {
            throw new EmailDomainsNotEditableError(PlatformEmailDomains.NotEditableMessage)
        }
        const updated = await this.directory.SetTenantEmailDomains(tenantId, domains)
        return { domains: PlatformEmailDomains.RecordDomainsOf(updated), editable: true, inHive: false }
    }

    /**
     * Approves one domain the tenant's in-hive console currently advertises. Throws UnknownTenantError, InvalidEmailDomainError
     * (the policy refuses it) or EmailDomainApprovalRefusedError (not in-hive, not advertised, or no approval store).
     */
    public async Approve(tenantId: string, domain: string): Promise<void>
    {
        const normalised = this.NormalisedFor(tenantId, domain)
        if (!this.IsInHive(tenantId))
        {
            throw new EmailDomainApprovalRefusedError(PlatformEmailDomains.NotInHiveMessage)
        }
        if (!(this.AdvertOf(tenantId)?.emailDomains ?? []).includes(normalised))
        {
            throw new EmailDomainApprovalRefusedError(normalised + PlatformEmailDomains.NotAdvertisedSuffix)
        }
        await this.ApprovalStore().Approve(tenantId, normalised)
    }

    /**
     * Withdraws one domain's approval (a no-op when it was not approved). Allowed for any known tenant and without the policy check
     * (normalised only), so any stored approval can always be cleared, even one for a domain the policy has since come to refuse.
     */
    public async Revoke(tenantId: string, domain: string): Promise<void>
    {
        this.AssertKnown(tenantId)
        await this.ApprovalStore().Revoke(tenantId, EmailDomainPolicy.Normalise(domain))
    }

    private AssertKnown(tenantId: string): void
    {
        if (this.directory.GetTenant(tenantId) === undefined)
        {
            throw new UnknownTenantError(tenantId)
        }
    }

    /** The normalised domain; throws UnknownTenantError for an unknown tenant and InvalidEmailDomainError for a refused domain. */
    private NormalisedFor(tenantId: string, domain: string): string
    {
        this.AssertKnown(tenantId)
        const normalised = EmailDomainPolicy.Normalise(domain)
        const refusal = EmailDomainPolicy.Check(normalised)
        if (refusal !== undefined)
        {
            throw new InvalidEmailDomainError(refusal)
        }
        return normalised
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
