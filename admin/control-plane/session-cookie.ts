export class SessionCookie
{
    private static readonly Name = 'cp_session'
    private static readonly HttpOnly = 'HttpOnly'
    private static readonly SameSite = 'SameSite=Strict'
    private static readonly PathAttr = 'Path=/'
    private static readonly MaxAgePrefix = 'Max-Age='
    private static readonly SecureAttr = 'Secure'
    private static readonly AttrSeparator = '; '
    private static readonly PairSeparator = ';'
    private static readonly Equals = '='
    private static readonly MillisPerSecond = 1000

    public static Build(token: string, expiresAt: Date, secure: boolean): string
    {
        const seconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / SessionCookie.MillisPerSecond))
        return SessionCookie.Compose(token, seconds, secure)
    }

    public static BuildClearing(secure: boolean): string
    {
        return SessionCookie.Compose('', 0, secure)
    }

    public static Read(cookieHeader: string | undefined): string | undefined
    {
        if (cookieHeader === undefined)
        {
            return undefined
        }
        const prefix = SessionCookie.Name + SessionCookie.Equals
        for (const pair of cookieHeader.split(SessionCookie.PairSeparator))
        {
            const trimmed = pair.trim()
            if (trimmed.startsWith(prefix))
            {
                return trimmed.slice(prefix.length)
            }
        }
        return undefined
    }

    private static Compose(value: string, maxAge: number, secure: boolean): string
    {
        const parts = [
            SessionCookie.Name + SessionCookie.Equals + value,
            SessionCookie.HttpOnly,
            SessionCookie.SameSite,
            SessionCookie.PathAttr,
            SessionCookie.MaxAgePrefix + maxAge,
        ]
        if (secure)
        {
            parts.push(SessionCookie.SecureAttr)
        }
        return parts.join(SessionCookie.AttrSeparator)
    }
}
