import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';

/**
 * The login domain's single sign-on cookie: the random session id, HttpOnly, SameSite=Lax (the authorize request is a
 * cross-site top-level navigation from the relying party), Secure, scoped to the realm's path so realms of one service
 * never see each other's session.
 */
export class IdpSsoCookie
{
    public static readonly Name = 'idp_sso';
    private static readonly HttpOnlyAttribute = 'HttpOnly';
    private static readonly SameSiteAttribute = 'SameSite=Lax';
    private static readonly PathPrefix = 'Path=/';
    private static readonly Slash = '/';
    private static readonly SecureAttribute = 'Secure';
    private static readonly ExpiresPrefix = 'Expires=';
    private static readonly MaxAgeZero = 'Max-Age=0';
    private static readonly AttributeSeparator = '; ';
    private static readonly PairSeparator = ';';
    private static readonly ValueSeparator = '=';
    private static readonly Cleared = '';

    public static Build(realmId: string, id: string, expiresAt: Date, secure: boolean): string
    {
        const C = IdpSsoCookie;
        return C.Attributes(realmId, id, secure, C.ExpiresPrefix + expiresAt.toUTCString());
    }

    /** A Set-Cookie value that removes the realm's cookie. */
    public static Clear(realmId: string, secure: boolean): string
    {
        return IdpSsoCookie.Attributes(realmId, IdpSsoCookie.Cleared, secure, IdpSsoCookie.MaxAgeZero);
    }

    public static Read(cookieHeader: string | undefined): string | undefined
    {
        if (cookieHeader === undefined)
        {
            return undefined;
        }
        for (const pair of cookieHeader.split(IdpSsoCookie.PairSeparator))
        {
            const index = pair.indexOf(IdpSsoCookie.ValueSeparator);
            if (index > 0 && pair.slice(0, index).trim() === IdpSsoCookie.Name)
            {
                const value = pair.slice(index + 1).trim();
                return value === IdpSsoCookie.Cleared ? undefined : value;
            }
        }
        return undefined;
    }

    private static Attributes(realmId: string, value: string, secure: boolean, lifetime: string): string
    {
        const C = IdpSsoCookie;
        const parts = [
            C.Name + C.ValueSeparator + value,
            C.HttpOnlyAttribute,
            C.SameSiteAttribute,
            C.PathPrefix + RealmIssuer.RealmsSegment + C.Slash + encodeURIComponent(realmId) + C.Slash,
        ];
        if (secure)
        {
            parts.push(C.SecureAttribute);
        }
        parts.push(lifetime);
        return parts.join(C.AttributeSeparator);
    }
}
