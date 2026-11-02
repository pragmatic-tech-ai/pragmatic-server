import { OptionViewModel } from '../../shell/option-view-model.js'

// How long an issued API token stays valid.
export enum TokenDuration
{
    OneHour,
    OneDay,
    ThirtyDays,
    Never,
}

// The durations the Issue token dialog offers, their labels, and what each
// sends as expiresInSeconds (null: the token never expires).
export class TokenDurations
{
    public static readonly Default = TokenDuration.OneDay

    private static readonly OneHourLabel = '1 hour'
    private static readonly OneDayLabel = '1 day'
    private static readonly ThirtyDaysLabel = '30 days'
    private static readonly NeverLabel = 'Never expires'
    private static readonly OneHourSeconds = 3600
    private static readonly OneDaySeconds = 86400
    private static readonly ThirtyDaysSeconds = 2592000

    public static SecondsFor(duration: TokenDuration): number | null
    {
        switch (duration)
        {
            case TokenDuration.OneHour:
                return TokenDurations.OneHourSeconds
            case TokenDuration.OneDay:
                return TokenDurations.OneDaySeconds
            case TokenDuration.ThirtyDays:
                return TokenDurations.ThirtyDaysSeconds
            case TokenDuration.Never:
                return null
        }
    }

    public static LabelOf(duration: TokenDuration): string
    {
        switch (duration)
        {
            case TokenDuration.OneHour:
                return TokenDurations.OneHourLabel
            case TokenDuration.OneDay:
                return TokenDurations.OneDayLabel
            case TokenDuration.ThirtyDays:
                return TokenDurations.ThirtyDaysLabel
            case TokenDuration.Never:
                return TokenDurations.NeverLabel
        }
    }

    // One option per duration, in the order offered.
    public static Options(): OptionViewModel<TokenDuration>[]
    {
        const all = [TokenDuration.OneHour, TokenDuration.OneDay, TokenDuration.ThirtyDays, TokenDuration.Never]
        return all.map(d => new OptionViewModel(d, TokenDurations.LabelOf(d)))
    }
}
