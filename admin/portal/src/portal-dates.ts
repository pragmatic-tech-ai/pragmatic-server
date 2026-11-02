export class PortalDates
{
    private static readonly UnknownLabel = 'Unknown'
    private static readonly DateLength = 10
    private static readonly DateTimeLength = 16
    private static readonly IsoTimeSeparator = 'T'
    private static readonly TimeSeparator = ' '

    // The UTC date, YYYY-MM-DD.
    public static Label(iso: string | undefined): string
    {
        if (!iso || Number.isNaN(new Date(iso).getTime()))
        {
            return PortalDates.UnknownLabel
        }
        return new Date(iso).toISOString().slice(0, PortalDates.DateLength)
    }

    // The UTC date and time to the minute, YYYY-MM-DD HH:MM.
    public static DateTimeLabel(iso: string | undefined): string
    {
        if (!iso || Number.isNaN(new Date(iso).getTime()))
        {
            return PortalDates.UnknownLabel
        }
        return new Date(iso).toISOString().slice(0, PortalDates.DateTimeLength).replace(PortalDates.IsoTimeSeparator, PortalDates.TimeSeparator)
    }
}
