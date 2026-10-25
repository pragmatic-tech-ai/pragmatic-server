import { PlaneHttp } from '../plane-http.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'

/** Maps a tenant subdomain Host header (`<tenantId>.<baseDomain>`) to a known tenant id. */
export class TenantHostResolver
{
    private static readonly CallbackPath = '/tenant-auth/oidc/callback'
    private static readonly LabelSeparator = '.'
    private static readonly SchemeSeparator = '://'
    private static readonly BadBaseDomainMessage = 'baseDomain must be a non-empty host with no leading dot'
    private readonly baseDomain: string

    public constructor(
        baseDomain: string,
        private readonly externalScheme: string,
        private readonly directory: ITenantDirectory
    )
    {
        const normalized = baseDomain.toLowerCase()
        // A blank base domain would make the suffix just "." (so `acme.` resolves to a tenant); a leading dot
        // would fail every match closed. Both are operator misconfiguration — reject at construction, not per request.
        if (normalized === '' || normalized.startsWith(TenantHostResolver.LabelSeparator))
        {
            throw new Error(TenantHostResolver.BadBaseDomainMessage)
        }
        this.baseDomain = normalized
    }

    /** The tenant id for a host exactly one label under the base domain, or undefined. */
    public TenantFor(hostHeader: string | undefined): string | undefined
    {
        const host = PlaneHttp.HostName(hostHeader)
        if (host === undefined)
        {
            return undefined
        }
        const suffix = TenantHostResolver.LabelSeparator + this.baseDomain
        if (!host.endsWith(suffix))
        {
            return undefined
        }
        const label = host.slice(0, -suffix.length)
        if (label === '' || label.includes(TenantHostResolver.LabelSeparator))
        {
            return undefined
        }
        return this.directory.GetTenant(label) !== undefined ? label : undefined
    }

    public Accepts(hostHeader: string | undefined): boolean
    {
        return this.TenantFor(hostHeader) !== undefined
    }

    public CallbackFor(hostHeader: string): string
    {
        return this.externalScheme + TenantHostResolver.SchemeSeparator + PlaneHttp.HostName(hostHeader) + TenantHostResolver.CallbackPath
    }
}
