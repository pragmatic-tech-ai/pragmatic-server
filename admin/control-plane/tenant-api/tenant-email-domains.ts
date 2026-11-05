/** A tenant's email domains as its console shows them; `editable` = whether the store may change them (the role is checked by the endpoint). */
export type TenantEmailDomainsView = { domains: string[]; editable: boolean }

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

/**
 * Where the tenant plane reads and writes a tenant's email domains. The control plane's PlatformEmailDomains and the
 * in-hive console's own store both satisfy it; the endpoint only ever passes the session's tenant id.
 */
export interface ITenantEmailDomains
{
    /** editable = whether this store may change the tenant's domains (the caller's role is checked by the endpoint). */
    For(tenantId: string): TenantEmailDomainsView
    /** Throws InvalidEmailDomainError (400) or EmailDomainsNotEditableError (409). */
    Set(tenantId: string, domains: unknown): Promise<TenantEmailDomainsView>
}
