import { PlaneHttp } from '../plane-http.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'

/** A host (not a tenant subdomain) that answers for one tenant: the tenant console's own host. */
export type ConsoleHostAlias = { host: string; tenantId: string }

/**
 * Maps a tenant subdomain Host header (`<tenantId>.<baseDomain>`) to a known tenant id, and is the one builder of a
 * tenant's external origin (`<scheme>://<tenantId>.<baseDomain>[:<externalPort>]`) and of its OIDC callback.
 * With an external port (one that is not the scheme's default) the origin carries it, and a Host header must carry no
 * port or exactly that one; without one, the origin has no port and any Host port matches (proxy-fronted default).
 */
export class TenantHostResolver
{
    private static readonly CallbackPath = '/tenant-auth/oidc/callback'
    private static readonly LabelSeparator = '.'
    private static readonly SchemeSeparator = '://'
    private static readonly PortSeparator = ':'
    private static readonly NoPort = ''
    private static readonly BadBaseDomainMessage = 'baseDomain must be a non-empty host with no leading dot'
    private static readonly BadExternalPortMessage = 'externalPort must be an integer in 1..65535'
    private static readonly MaxPort = 65535
    private static readonly DefaultPorts: ReadonlyMap<string, number> = new Map([['http', 80], ['https', 443]])
    private readonly baseDomain: string
    /** The port the tenant origin shows; undefined when none (unset, or the scheme's default). */
    private readonly originPort: number | undefined
    private readonly consoleAlias: ConsoleHostAlias | undefined

    public constructor(
        baseDomain: string,
        private readonly externalScheme: string,
        private readonly directory: ITenantDirectory,
        externalPort?: number,
        consoleHost?: ConsoleHostAlias
    )
    {
        if (externalPort !== undefined && (!Number.isInteger(externalPort) || externalPort < 1 || externalPort > TenantHostResolver.MaxPort))
        {
            throw new Error(TenantHostResolver.BadExternalPortMessage)
        }
        this.originPort = externalPort === TenantHostResolver.DefaultPorts.get(externalScheme.toLowerCase()) ? undefined : externalPort
        const normalized = baseDomain.toLowerCase()
        // A blank base domain would make the suffix just "." (so `acme.` resolves to a tenant); a leading dot
        // would fail every match closed. Both are operator misconfiguration — reject at construction, not per request.
        if (normalized === '' || normalized.startsWith(TenantHostResolver.LabelSeparator))
        {
            throw new Error(TenantHostResolver.BadBaseDomainMessage)
        }
        this.baseDomain = normalized
        this.consoleAlias = consoleHost === undefined ? undefined : { host: consoleHost.host.toLowerCase(), tenantId: consoleHost.tenantId }
    }

    /** The tenant id for a host exactly one label under the base domain, or undefined. */
    public TenantFor(hostHeader: string | undefined): string | undefined
    {
        const host = PlaneHttp.HostName(hostHeader)
        if (host === undefined)
        {
            return undefined
        }
        // With an external port, the Host may carry no port or exactly that one: anything else is not this origin.
        const port = PlaneHttp.HostPort(hostHeader)
        if (this.originPort !== undefined && port !== undefined && port !== this.originPort)
        {
            return undefined
        }
        if (this.consoleAlias !== undefined && host === this.consoleAlias.host)
        {
            return this.directory.GetTenant(this.consoleAlias.tenantId) !== undefined ? this.consoleAlias.tenantId : undefined
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

    /** The tenant host's external origin: scheme, the host name, and the external port when one is configured. */
    public OriginFor(hostHeader: string): string
    {
        const port = this.originPort === undefined ? TenantHostResolver.NoPort : TenantHostResolver.PortSeparator + String(this.originPort)
        return this.externalScheme + TenantHostResolver.SchemeSeparator + PlaneHttp.HostName(hostHeader) + port
    }

    /**
     * The tenant plane's Origin check (CSRF): an absent Origin is allowed (non-browser / same-origin navigation); a present
     * one must be exactly this host's tenant origin (OriginFor: scheme, host and external port).
     */
    public OriginAllowed(originHeader: string | string[] | undefined, hostHeader: string | undefined): boolean
    {
        if (originHeader === undefined)
        {
            return true
        }
        if (typeof originHeader !== 'string' || hostHeader === undefined || PlaneHttp.HostName(hostHeader) === undefined)
        {
            return false
        }
        try
        {
            return new URL(originHeader).origin === new URL(this.OriginFor(hostHeader)).origin
        }
        catch
        {
            return false
        }
    }

    public CallbackFor(hostHeader: string): string
    {
        return this.OriginFor(hostHeader) + TenantHostResolver.CallbackPath
    }
}
