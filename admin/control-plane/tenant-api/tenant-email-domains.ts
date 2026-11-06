import type { DomainVerificationView } from '../domain-verification-record.js'

/**
 * A tenant's email domains as its console shows them; `editable` = whether the store may change them (the role is checked by the endpoint);
 * `inHive` = whether the tenant's console runs in its own hive. A domain takes effect once the platform operator approves it, or once
 * its DNS TXT record is verified and no other tenant claims it, unless an operator revoked it: `pending` = the domains not in effect
 * yet, sorted. `verifications` = one entry per claimed domain that has a verification token, in `domains` order, carrying the TXT
 * record to publish and the domain's state. The in-hive console answers only what it has learnt from the control plane.
 */
export type TenantEmailDomainsView = { domains: string[]; editable: boolean; inHive: boolean; pending: string[]; verifications: DomainVerificationView[] }

/** What both email-domain write routes (tenant plane and operator) promise: one home so the two cannot drift. */
export class TenantEmailDomainsLimits
{
    /** 20 domains of up to 253 characters each do not fit the planes' default 4 KiB body cap. */
    public static readonly MaxBodyBytes = 16384
    public static readonly DomainsRequiredMessage = 'domains (array of domain names) is required'
    public static readonly DomainRequiredMessage = 'domain (an email domain name) is required'
}

/** The store cannot change this tenant's email domains (they are set elsewhere); the message is one plain sentence (maps to 409). */
export class EmailDomainsNotEditableError extends Error
{
    private static readonly ErrorName = 'EmailDomainsNotEditableError'

    public constructor(message: string)
    {
        super(message)
        this.name = EmailDomainsNotEditableError.ErrorName
    }
}

/** The domain to verify is not among the tenant's claimed email domains; the message is one plain sentence (maps to 409). */
export class DomainNotClaimedError extends Error
{
    private static readonly ErrorName = 'DomainNotClaimedError'

    public constructor(message: string)
    {
        super(message)
        this.name = DomainNotClaimedError.ErrorName
    }
}

/** Too many verification lookups for this tenant in the current window; the message is one plain sentence (maps to 429). */
export class DomainVerifyThrottledError extends Error
{
    private static readonly ErrorName = 'DomainVerifyThrottledError'

    public constructor(message: string)
    {
        super(message)
        this.name = DomainVerifyThrottledError.ErrorName
    }
}

/** Verification cannot run or its DNS lookup did not complete; nothing was stored; the message is one plain sentence (maps to 503). */
export class DomainVerificationUnavailableError extends Error
{
    private static readonly ErrorName = 'DomainVerificationUnavailableError'

    public constructor(message: string)
    {
        super(message)
        this.name = DomainVerificationUnavailableError.ErrorName
    }
}

/**
 * Where the tenant plane reads and writes a tenant's email domains. The control plane's PlatformEmailDomains and the
 * in-hive console's own store both satisfy it; the endpoint only ever passes the session's tenant id.
 */
export interface ITenantEmailDomains
{
    /** editable = whether this store may change the tenant's domains (the caller's role is checked by the endpoint). */
    For(tenantId: string): Promise<TenantEmailDomainsView>
    /** Throws InvalidEmailDomainError (400) or EmailDomainsNotEditableError (409). */
    Set(tenantId: string, domains: unknown): Promise<TenantEmailDomainsView>
    /**
     * Checks one claimed domain's DNS TXT record now and answers the updated view. Throws InvalidEmailDomainError (400),
     * DomainNotClaimedError (409), DomainVerifyThrottledError (429) or DomainVerificationUnavailableError (503).
     */
    Verify(tenantId: string, domain: string): Promise<TenantEmailDomainsView>
}
