export class InvalidHiveClusterNameError extends Error
{
    private static readonly NamePrefix = 'InvalidHiveClusterNameError'
    private static readonly MessagePrefix = 'Hive id is not a valid kind cluster name component: '

    public constructor(hiveId: string)
    {
        super(InvalidHiveClusterNameError.MessagePrefix + JSON.stringify(hiveId))
        this.name = InvalidHiveClusterNameError.NamePrefix
    }
}

/** Derives and validates the kind cluster name for a platform hive. Fail-closed. */
export class KindClusterName
{
    private static readonly Prefix = 'pragmatic-hive-'
    private static readonly ContextPrefix = 'kind-'
    private static readonly Pattern = /^[a-z0-9-]+$/
    private static readonly MaxLength = 49

    public static For(hiveId: string): string
    {
        const clusterName = KindClusterName.Prefix + hiveId
        if (hiveId.length === 0 || !KindClusterName.Pattern.test(clusterName) || clusterName.length > KindClusterName.MaxLength)
        {
            throw new InvalidHiveClusterNameError(hiveId)
        }
        return clusterName
    }

    public static ContextFor(clusterName: string): string
    {
        return KindClusterName.ContextPrefix + clusterName
    }
}
