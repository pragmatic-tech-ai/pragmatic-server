export class UnknownManifestError extends Error
{
    private static readonly ErrorName = 'UnknownManifestError'
    private static readonly MessagePrefix = 'Unknown manifest: '

    public constructor(id: string)
    {
        super(UnknownManifestError.MessagePrefix + id)
        this.name = UnknownManifestError.ErrorName
    }
}

export class ManifestExistsError extends Error
{
    private static readonly ErrorName = 'ManifestExistsError'
    private static readonly MessagePrefix = 'Manifest already published: '

    public constructor(id: string)
    {
        super(ManifestExistsError.MessagePrefix + id)
        this.name = ManifestExistsError.ErrorName
    }
}

export class ManifestNotGatedError extends Error
{
    private static readonly ErrorName = 'ManifestNotGatedError'
    private static readonly MessagePrefix = 'Manifest not gated for tenant: '

    public constructor(id: string)
    {
        super(ManifestNotGatedError.MessagePrefix + id)
        this.name = ManifestNotGatedError.ErrorName
    }
}

export class HiveNotRegisteredError extends Error
{
    private static readonly ErrorName = 'HiveNotRegisteredError'
    private static readonly MessagePrefix = 'Hive not registered for rollout: '

    public constructor(id: string)
    {
        super(HiveNotRegisteredError.MessagePrefix + id)
        this.name = HiveNotRegisteredError.ErrorName
    }
}

export class AgentUnauthorizedError extends Error
{
    private static readonly ErrorName = 'AgentUnauthorizedError'
    private static readonly MessagePrefix = 'Agent unauthorized for hive: '

    public constructor(id: string)
    {
        super(AgentUnauthorizedError.MessagePrefix + id)
        this.name = AgentUnauthorizedError.ErrorName
    }
}

export class UnknownHiveError extends Error
{
    private static readonly ErrorName = 'UnknownHiveError'
    private static readonly MessagePrefix = 'Unknown hive: '

    public constructor(id: string)
    {
        super(UnknownHiveError.MessagePrefix + id)
        this.name = UnknownHiveError.ErrorName
    }
}

/** A request body exceeded the host's size cap. */
export class BodyTooLargeError extends Error
{
    private static readonly ErrorName = 'BodyTooLargeError'
    private static readonly DefaultMessage = 'Request body too large'

    public constructor(message: string = BodyTooLargeError.DefaultMessage)
    {
        super(message)
        this.name = BodyTooLargeError.ErrorName
    }
}

export class ManifestWithdrawnError extends Error
{
    private static readonly ErrorName = 'ManifestWithdrawnError'
    private static readonly MessagePrefix = 'Manifest withdrawn: '

    public constructor(id: string)
    {
        super(ManifestWithdrawnError.MessagePrefix + id)
        this.name = ManifestWithdrawnError.ErrorName
    }
}

export class TenantOnHoldError extends Error
{
    private static readonly ErrorName = 'TenantOnHoldError'
    private static readonly MessagePrefix = 'Tenant on hold: '

    public constructor(id: string)
    {
        super(TenantOnHoldError.MessagePrefix + id)
        this.name = TenantOnHoldError.ErrorName
    }
}

export class ChannelNotSubscribedError extends Error
{
    private static readonly ErrorName = 'ChannelNotSubscribedError'
    private static readonly MessagePrefix = 'Channel not subscribed: '

    public constructor(id: string)
    {
        super(ChannelNotSubscribedError.MessagePrefix + id)
        this.name = ChannelNotSubscribedError.ErrorName
    }
}

export class VersionBelowFloorError extends Error
{
    private static readonly ErrorName = 'VersionBelowFloorError'
    private static readonly MessagePrefix = 'Version below floor: '

    public constructor(id: string)
    {
        super(VersionBelowFloorError.MessagePrefix + id)
        this.name = VersionBelowFloorError.ErrorName
    }
}
