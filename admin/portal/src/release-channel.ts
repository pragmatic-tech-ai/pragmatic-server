// Single home for the release-channel wire values (mirrors the DTO's 'stable' | 'early' union).
export class ReleaseChannel
{
    public static readonly Stable = 'stable'
    public static readonly Early = 'early'

    private static readonly StableLabel = 'Stable'
    private static readonly EarlyLabel = 'Early access'

    // The channel's display name; a version without a channel is Stable.
    public static Label(channel: string | undefined): string
    {
        return channel === ReleaseChannel.Early ? ReleaseChannel.EarlyLabel : ReleaseChannel.StableLabel
    }
}
