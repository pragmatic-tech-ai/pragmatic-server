export class PortalDates
{
    private static readonly UnknownLabel = 'Unknown'
    private static readonly DateLength = 10

    public static Label(iso: string | undefined): string
    {
        if (!iso || Number.isNaN(new Date(iso).getTime()))
        {
            return PortalDates.UnknownLabel
        }
        return new Date(iso).toISOString().slice(0, PortalDates.DateLength)
    }
}
