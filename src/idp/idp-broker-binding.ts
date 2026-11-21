import { timingSafeEqual } from 'node:crypto';
import { OpaqueToken } from './opaque-token.js';
import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';

/** What an upstream round trip carries: the browser binding's digest and the realm's authorize request. */
export class BrokerReturn
{
    public constructor(public readonly BindingHash: string, public readonly AuthorizeRequest: string)
    {
        Object.freeze(this);
    }
}

/**
 * Binds an upstream sign-in to the browser that began it (login CSRF: without it, an attacker could hand a victim the
 * callback of the attacker's own upstream sign-in, and the victim's browser would get an SSO session as the attacker).
 * The broker's begin sets a random value in a short-lived cookie scoped to the realm's broker path and carries its
 * digest with the authorize request through the flow state; the callback admits only a browser holding the value. The
 * cookie is SameSite=Lax: the callback is a cross-site top-level navigation back from the upstream.
 */
export class IdpBrokerBinding
{
    public static readonly CookieName = 'idp_broker';
    private static readonly LifetimeSeconds = 600;
    private static readonly Separator = ' ';
    private static readonly AttributeSeparator = '; ';
    private static readonly PairSeparator = ';';
    private static readonly ValueSeparator = '=';
    private static readonly HttpOnly = 'HttpOnly';
    private static readonly SameSiteLax = 'SameSite=Lax';
    private static readonly Secure = 'Secure';
    private static readonly PathPrefix = 'Path=/';
    private static readonly Slash = '/';
    private static readonly BrokerSegment = 'broker';
    private static readonly MaxAgePrefix = 'Max-Age=';
    private static readonly Cleared = '';
    private static readonly HexEncoding = 'hex';

    /** A new binding: the cookie value and what the flow state carries. */
    public static Begin(authorizeRequest: string): { Value: string; ReturnPath: string }
    {
        const value = OpaqueToken.New();
        return { Value: value, ReturnPath: OpaqueToken.Hash(value) + IdpBrokerBinding.Separator + authorizeRequest };
    }

    /** The return path's parts; undefined when it is not one this binding wrote. */
    public static Parse(returnPath: string): BrokerReturn | undefined
    {
        const at = returnPath.indexOf(IdpBrokerBinding.Separator);
        return at <= 0 ? undefined : new BrokerReturn(returnPath.slice(0, at), returnPath.slice(at + 1));
    }

    /** Whether the browser's cookie holds the value whose digest the round trip carried. */
    public static Admits(cookieHeader: string | undefined, carried: BrokerReturn): boolean
    {
        const value = IdpBrokerBinding.Read(cookieHeader);
        if (value === undefined)
        {
            return false;
        }
        const presented = Buffer.from(OpaqueToken.Hash(value), IdpBrokerBinding.HexEncoding);
        const expected = Buffer.from(carried.BindingHash, IdpBrokerBinding.HexEncoding);
        return presented.length === expected.length && timingSafeEqual(presented, expected);
    }

    public static Cookie(realmId: string, value: string, secure: boolean): string
    {
        return IdpBrokerBinding.Build(realmId, value, IdpBrokerBinding.LifetimeSeconds, secure);
    }

    public static Clear(realmId: string, secure: boolean): string
    {
        return IdpBrokerBinding.Build(realmId, IdpBrokerBinding.Cleared, 0, secure);
    }

    private static Build(realmId: string, value: string, maxAge: number, secure: boolean): string
    {
        const B = IdpBrokerBinding;
        const parts = [
            B.CookieName + B.ValueSeparator + value,
            B.HttpOnly,
            B.SameSiteLax,
            B.PathPrefix + RealmIssuer.RealmsSegment + B.Slash + encodeURIComponent(realmId) + B.Slash + B.BrokerSegment + B.Slash,
            B.MaxAgePrefix + String(maxAge),
        ];
        if (secure)
        {
            parts.push(B.Secure);
        }
        return parts.join(B.AttributeSeparator);
    }

    private static Read(cookieHeader: string | undefined): string | undefined
    {
        for (const pair of (cookieHeader ?? IdpBrokerBinding.Cleared).split(IdpBrokerBinding.PairSeparator))
        {
            const index = pair.indexOf(IdpBrokerBinding.ValueSeparator);
            if (index > 0 && pair.slice(0, index).trim() === IdpBrokerBinding.CookieName)
            {
                const value = pair.slice(index + 1).trim();
                return value === IdpBrokerBinding.Cleared ? undefined : value;
            }
        }
        return undefined;
    }
}
