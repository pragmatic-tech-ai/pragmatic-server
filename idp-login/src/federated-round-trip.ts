import type { LoginPageLocation } from './login-page-location.js'

// The part of the Web Storage API the round trip needs (sessionStorage in the browser).
export interface IRoundTripStorage
{
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
}

// A federated sign-in in flight: the Identity Platform session of its
// createAuthUri and the original authorize request the page was served for.
export class PendingFederatedSignIn
{
    public constructor(public readonly SessionId: string, public readonly Request: string, public readonly IssuerPath: string)
    {
    }
}

// Carries a federated sign-in across the provider's round trip. Before the
// page leaves for the provider it saves the session and the ORIGINAL authorize
// request; when the provider sends the browser back to the page (the authorize
// URL with the provider's answer appended to its query) the page takes them
// back, posts the original request (not the returned URL's query) and signs in.
export class FederatedRoundTrip
{
    private static readonly StorageKey = 'pragmatic-login.federated'
    private static readonly SessionField = 'sessionId'
    private static readonly RequestField = 'request'
    private static readonly IssuerField = 'issuer'

    public constructor(private readonly storage: IRoundTripStorage)
    {
    }

    public Save(pending: PendingFederatedSignIn): void
    {
        const F = FederatedRoundTrip
        this.storage.setItem(F.StorageKey, JSON.stringify({ [F.SessionField]: pending.SessionId, [F.RequestField]: pending.Request, [F.IssuerField]: pending.IssuerPath }))
    }

    // The page's location under the realm a saved round trip began in, when the page was served at the login domain's
    // federated return handler (whose path names no realm); the location as it is otherwise. Nothing is removed.
    public Locate(location: LoginPageLocation): LoginPageLocation
    {
        const saved = location.IsFederatedReturn ? this.storage.getItem(FederatedRoundTrip.StorageKey) : null
        const pending = saved === null ? undefined : FederatedRoundTrip.Parse(saved)
        return pending === undefined ? location : location.WithIssuer(pending.IssuerPath)
    }

    // The saved sign-in, once (it is removed), when the page came back with more
    // in its query than the request it left with; undefined otherwise (nothing
    // saved, or the page was reloaded without the provider's answer).
    public Take(currentRequest: string): PendingFederatedSignIn | undefined
    {
        const F = FederatedRoundTrip
        const saved = this.storage.getItem(F.StorageKey)
        if (saved === null)
        {
            return undefined
        }
        this.storage.removeItem(F.StorageKey)
        const pending = F.Parse(saved)
        if (pending === undefined || currentRequest === pending.Request)
        {
            return undefined
        }
        return pending
    }

    private static Parse(saved: string): PendingFederatedSignIn | undefined
    {
        const F = FederatedRoundTrip
        try
        {
            const value = JSON.parse(saved) as Record<string, unknown> | null
            const session = value?.[F.SessionField]
            const request = value?.[F.RequestField]
            const issuer = value?.[F.IssuerField]
            return typeof session === 'string' && typeof request === 'string' && typeof issuer === 'string' ? new PendingFederatedSignIn(session, request, issuer) : undefined
        }
        catch
        {
            return undefined
        }
    }
}
