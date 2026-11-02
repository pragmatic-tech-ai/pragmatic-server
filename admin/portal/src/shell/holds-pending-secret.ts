// A page that is showing a one-time value (an Owner password, a reset
// password, a bootstrap's agent token) the operator has not yet confirmed
// saving. Its section never drops or covers it while HasPendingSecret is
// true: the value is shown once and must stay until "I've saved it".
// The page raises PendingSecret.ChangedProperty whenever HasPendingSecret flips.
export interface IHoldsPendingSecret
{
    readonly HasPendingSecret: boolean
}

// Recognises a page holding a pending one-time value. Holding pages register
// themselves (Register) in their constructor, so recognition is by identity,
// not by a member-name probe.
export class PendingSecret
{
    public static readonly ChangedProperty = 'HasPendingSecret'

    private static readonly holders = new WeakSet<object>()

    public static Register(page: IHoldsPendingSecret): void
    {
        PendingSecret.holders.add(page)
    }

    public static IsHolder(page: object | undefined): page is IHoldsPendingSecret
    {
        return page !== undefined && PendingSecret.holders.has(page)
    }

    public static IsHeldBy(page: object | undefined): boolean
    {
        return PendingSecret.IsHolder(page) && page.HasPendingSecret
    }
}
