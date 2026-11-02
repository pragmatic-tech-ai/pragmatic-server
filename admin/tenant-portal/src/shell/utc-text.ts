// UTC renderings of a wire timestamp; the raw text when it does not parse.
export class UtcText
{
    private static readonly IsoSeparator = 'T'
    private static readonly DateTimeSeparator = ' '
    private static readonly UtcSuffix = ' UTC'
    private static readonly DateTimeLength = 16
    private static readonly DateLength = 10

    // "YYYY-MM-DD HH:MM UTC".
    public static DateTime(at: string): string
    {
        const iso = UtcText.Iso(at)
        return iso === undefined
            ? at
            : iso.replace(UtcText.IsoSeparator, UtcText.DateTimeSeparator).slice(0, UtcText.DateTimeLength) + UtcText.UtcSuffix
    }

    // "YYYY-MM-DD".
    public static Date(at: string): string
    {
        const iso = UtcText.Iso(at)
        return iso === undefined ? at : iso.slice(0, UtcText.DateLength)
    }

    private static Iso(at: string): string | undefined
    {
        const ms = Date.parse(at)
        return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
    }
}
