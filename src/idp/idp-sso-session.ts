import { randomBytes } from 'node:crypto';

/** A server-side record of one IdP single-sign-on login. */
export class IdpSsoSession
{
    public constructor(
        public readonly PrincipalId: string,
        public readonly TenantId: string,
        public readonly ExpiresAt: Date)
    {
    }
}

/** Server-side id->record map; the opaque id is the secret and must never be logged. */
export class IdpSsoSessionStore
{
    public static readonly DefaultTtlMs = 8 * 60 * 60 * 1000;
    private static readonly IdBytes = 32;
    private static readonly IdEncoding = 'base64url';

    private readonly sessions = new Map<string, IdpSsoSession>();

    public constructor(
        private readonly now: () => Date = () => new Date(),
        private readonly ttlMs: number = IdpSsoSessionStore.DefaultTtlMs)
    {
    }

    public Issue(principalId: string, tenantId: string): { Id: string; session: IdpSsoSession }
    {
        const id = randomBytes(IdpSsoSessionStore.IdBytes).toString(IdpSsoSessionStore.IdEncoding);
        const session = new IdpSsoSession(principalId, tenantId, new Date(this.now().getTime() + this.ttlMs));
        this.sessions.set(id, session);
        return { Id: id, session };
    }

    public Validate(id: string, tenantId: string): IdpSsoSession | null
    {
        const session = this.sessions.get(id);
        if (session === undefined)
        {
            return null;
        }
        if (session.ExpiresAt.getTime() <= this.now().getTime())
        {
            this.sessions.delete(id);
            return null;
        }
        return session.TenantId === tenantId ? session : null;
    }

    public Revoke(id: string): void
    {
        this.sessions.delete(id);
    }
}

/** Builds and reads the IdP SSO cookie. SameSite=Lax so cross-site top-level redirects carry it. */
export class IdpSsoCookie
{
    public static readonly Name = 'idp_sso';
    private static readonly HttpOnlyAttribute = 'HttpOnly';
    private static readonly SameSiteAttribute = 'SameSite=Lax';
    private static readonly PathAttribute = 'Path=/';
    private static readonly SecureAttribute = 'Secure';
    private static readonly ExpiresPrefix = 'Expires=';
    private static readonly AttributeSeparator = '; ';
    private static readonly PairSeparator = ';';
    private static readonly ValueSeparator = '=';

    public static Build(id: string, expiresAt: Date, secure: boolean): string
    {
        const parts = [
            `${IdpSsoCookie.Name}${IdpSsoCookie.ValueSeparator}${id}`,
            IdpSsoCookie.HttpOnlyAttribute,
            IdpSsoCookie.SameSiteAttribute,
            IdpSsoCookie.PathAttribute,
        ];
        if (secure)
        {
            parts.push(IdpSsoCookie.SecureAttribute);
        }
        parts.push(`${IdpSsoCookie.ExpiresPrefix}${expiresAt.toUTCString()}`);
        return parts.join(IdpSsoCookie.AttributeSeparator);
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
                return pair.slice(index + 1).trim();
            }
        }
        return undefined;
    }
}
