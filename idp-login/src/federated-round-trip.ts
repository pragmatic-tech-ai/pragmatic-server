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
    public constructor(public readonly SessionId: string, public readonly Request: string)
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

    public constructor(private readonly storage: IRoundTripStorage)
    {
    }

    public Save(pending: PendingFederatedSignIn): void
    {
        const F = FederatedRoundTrip
        this.storage.setItem(F.StorageKey, JSON.stringify({ [F.SessionField]: pending.SessionId, [F.RequestField]: pending.Request }))
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
            return typeof session === 'string' && typeof request === 'string' ? new PendingFederatedSignIn(session, request) : undefined
        }
        catch
        {
            return undefined
        }
    }
}
