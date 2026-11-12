import { Channel } from '../channel.js'

export enum ReleaseApp
{
    PlatformAdmin = 'pragmatic-platform-admin',
    PlatformEdge = 'pragmatic-platform-edge',
    EnvServer = 'pragmatic-env-server',
    EnvGateway = 'pragmatic-env-gateway',
    HiveAgent = 'pragmatic-hive-agent',
    TenantAdmin = 'pragmatic-tenant-admin',
    TenantIdp = 'pragmatic-tenant-idp',
    UiUnpack = 'pragmatic-ui-unpack',
}

export class ReleaseApps
{
    public static readonly All: readonly ReleaseApp[] = [
        ReleaseApp.PlatformAdmin,
        ReleaseApp.PlatformEdge,
        ReleaseApp.EnvServer,
        ReleaseApp.EnvGateway,
        ReleaseApp.HiveAgent,
        ReleaseApp.TenantAdmin,
        ReleaseApp.TenantIdp,
        ReleaseApp.UiUnpack,
    ]
}

export class ReleaseTagInvalidError extends Error
{
    private static readonly ErrorName = 'ReleaseTagInvalidError'
    private static readonly MessagePrefix = 'Invalid release tag: '

    public constructor(ref: string)
    {
        super(ReleaseTagInvalidError.MessagePrefix + ref)
        this.name = ReleaseTagInvalidError.ErrorName
    }
}

/** A `release/X.Y.Z` (stable) or `release/X.Y.Z-early.N` (early access) git tag. */
export class ReleaseTag
{
    /** The git tag name prefix in front of the version. */
    public static readonly Prefix = 'release/'
    private static readonly RefPrefix = 'refs/tags/'
    private static readonly Pattern = /^release\/((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(-early\.(?:0|[1-9]\d*))?)$/

    private constructor(public readonly Version: string, public readonly Channel: Channel)
    {
    }

    public static Parse(ref: string): ReleaseTag
    {
        const name = ref.startsWith(ReleaseTag.RefPrefix) ? ref.slice(ReleaseTag.RefPrefix.length) : ref
        const match = ReleaseTag.Pattern.exec(name)
        if (match === null)
        {
            throw new ReleaseTagInvalidError(ref)
        }
        const channel = match[2] === undefined ? Channel.Stable : Channel.EarlyAccess
        return new ReleaseTag(match[1], channel)
    }

    /** The release tag for a bare version (`1.4.0`, `1.4.0-early.2`); throws ReleaseTagInvalidError for anything else. */
    public static FromVersion(version: string): ReleaseTag
    {
        return ReleaseTag.Parse(ReleaseTag.Prefix + version)
    }
}
