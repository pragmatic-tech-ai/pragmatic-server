// A page that is showing a one-time value (an Owner password, a reset
// password, a bootstrap's agent token) the operator has not yet confirmed
// saving. Its section never drops or covers it while HasPendingSecret is
// true: the value is shown once and must stay until "I've saved it".
export interface IHoldsPendingSecret
{
    readonly HasPendingSecret: boolean
}

// Recognises a page holding a pending one-time value.
export class PendingSecret
{
    private static readonly MemberName = 'HasPendingSecret'

    public static IsHeldBy(page: object | undefined): boolean
    {
        return page !== undefined
            && PendingSecret.MemberName in page
            && (page as IHoldsPendingSecret).HasPendingSecret === true
    }
}
