import { EnvStatus } from './tenant-types.js'
import type { EnvironmentDto, HiveHealthDto, Template } from './tenant-types.js'

// How a status or health reads at a glance: the tone its pill is drawn in.
export enum EnvironmentTone
{
    Success,
    Warning,
    Danger,
    Neutral,
}

// Read-only projection of an environment plus its (optional) hive health entry.
export class EnvironmentRow
{
    private static readonly NoVersion = '\u2014'
    private static readonly TagSeparator = ':'
    private static readonly EmptyText = ''
    private static readonly RunningLabel = 'Running'
    private static readonly StoppedLabel = 'Stopped'
    private static readonly FailedLabel = 'Failed'
    private static readonly UnknownLabel = 'Unknown'
    private static readonly HealthyLabel = 'Healthy'
    private static readonly FailingLabel = 'Failing'

    public constructor(public readonly Dto: EnvironmentDto, private readonly health?: HiveHealthDto)
    {
    }

    public get Name(): string
    {
        return this.Dto.name
    }

    public get EnvironmentId(): string
    {
        return this.Dto.environmentId
    }

    public get Template(): Template
    {
        return this.Dto.template
    }

    public get Status(): EnvStatus
    {
        return this.Dto.status
    }

    // The hive's health entry for this environment; undefined when unknown.
    public get Health(): HiveHealthDto | undefined
    {
        return this.health
    }

    public get StatusLabel(): string
    {
        switch (this.Dto.status)
        {
            case EnvStatus.Running:
                return EnvironmentRow.RunningLabel
            case EnvStatus.Stopped:
                return EnvironmentRow.StoppedLabel
            case EnvStatus.Failed:
                return EnvironmentRow.FailedLabel
            default:
                return EnvironmentRow.UnknownLabel
        }
    }

    public get StatusTone(): EnvironmentTone
    {
        switch (this.Dto.status)
        {
            case EnvStatus.Running:
                return EnvironmentTone.Success
            case EnvStatus.Failed:
                return EnvironmentTone.Danger
            default:
                return EnvironmentTone.Neutral
        }
    }

    public get HealthLabel(): string
    {
        if (this.health === undefined)
        {
            return EnvironmentRow.UnknownLabel
        }
        return this.health.ready ? EnvironmentRow.HealthyLabel : EnvironmentRow.FailingLabel
    }

    public get HealthTone(): EnvironmentTone
    {
        if (this.health === undefined)
        {
            return EnvironmentTone.Neutral
        }
        return this.health.ready ? EnvironmentTone.Success : EnvironmentTone.Danger
    }

    public static VersionOf(image: string | undefined): string
    {
        if (image === undefined || image === EnvironmentRow.EmptyText)
        {
            return EnvironmentRow.NoVersion
        }
        const i = image.lastIndexOf(EnvironmentRow.TagSeparator)
        const tag = i >= 0 ? image.substring(i + 1) : image
        return tag === EnvironmentRow.EmptyText ? EnvironmentRow.NoVersion : tag
    }

    public static UrlOf(status: EnvStatus, httpUrl: string): string | undefined
    {
        return status === EnvStatus.Running ? httpUrl : undefined
    }

    public get Version(): string
    {
        return EnvironmentRow.VersionOf(this.health?.runningImage)
    }

    public get RunningImage(): string | undefined
    {
        return this.health?.runningImage
    }

    public get Url(): string | undefined
    {
        return EnvironmentRow.UrlOf(this.Dto.status, this.Dto.httpUrl)
    }

    public get IsRunning(): boolean
    {
        return this.Dto.status === EnvStatus.Running
    }

    public get IsStopped(): boolean
    {
        return this.Dto.status === EnvStatus.Stopped
    }

    public get IsFailed(): boolean
    {
        return this.Dto.status === EnvStatus.Failed
    }

    public get IsUnknown(): boolean
    {
        return this.Dto.status === EnvStatus.Unknown
    }
}
