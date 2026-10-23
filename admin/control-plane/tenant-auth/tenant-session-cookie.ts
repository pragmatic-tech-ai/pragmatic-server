/** The tenant-plane session cookie: `pts_session=<tenant>.<token>`. The token is a secret: never log or echo it. */
export class TenantSessionCookie
{
    public static readonly Name = 'pts_session'
    private static readonly Equals = '='
    private static readonly PairSeparator = ';'
    private static readonly TenantTokenSeparator = '.'
    private static readonly TokenPattern = /^[A-Za-z0-9_-]+$/
    private static readonly Attributes = '; HttpOnly; SameSite=Strict; Path=/'
    private static readonly MaxAgeAttribute = '; Max-Age='
    private static readonly SecureAttribute = '; Secure'
    private static readonly MillisPerSecond = 1000

    public static Build(tenantId: string, token: string, expiresAt: Date, secure: boolean): string
    {
        const seconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / TenantSessionCookie.MillisPerSecond))
        return TenantSessionCookie.Compose(encodeURIComponent(tenantId) + TenantSessionCookie.TenantTokenSeparator + token, seconds, secure)
    }

    public static BuildClearing(secure: boolean): string
    {
        return TenantSessionCookie.Compose('', 0, secure)
    }

    /** The (tenant, token) the cookie carries, or null when absent, duplicated, or malformed. */
    public static Read(cookieHeader: string | undefined): { tenantId: string; token: string } | null
    {
        if (cookieHeader === undefined)
        {
            return null
        }
        let value: string | null = null
        for (const pair of cookieHeader.split(TenantSessionCookie.PairSeparator))
        {
            const index = pair.indexOf(TenantSessionCookie.Equals)
            if (index < 0 || pair.slice(0, index).trim() !== TenantSessionCookie.Name)
            {
                continue
            }
            if (value !== null)
            {
                return null
            }
            value = pair.slice(index + 1).trim()
        }
        if (value === null)
        {
            return null
        }
        const split = value.lastIndexOf(TenantSessionCookie.TenantTokenSeparator)
        if (split <= 0)
        {
            return null
        }
        const token = value.slice(split + 1)
        if (!TenantSessionCookie.TokenPattern.test(token))
        {
            return null
        }
        try
        {
            const tenantId = decodeURIComponent(value.slice(0, split))
            return tenantId.length > 0 ? { tenantId, token } : null
        }
        catch
        {
            return null
        }
    }

    private static Compose(value: string, maxAge: number, secure: boolean): string
    {
        return TenantSessionCookie.Name + TenantSessionCookie.Equals + value + TenantSessionCookie.Attributes
            + TenantSessionCookie.MaxAgeAttribute + maxAge + (secure ? TenantSessionCookie.SecureAttribute : '')
    }
}
