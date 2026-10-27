import { PillKind } from './kit/pill-kinds.js'
import { EnvStatus } from './tenant-types.js'
import type { EnvironmentDto, HiveHealthDto, Template } from './tenant-types.js'

// Read-only projection of an environment plus its (optional) hive health entry.
export class EnvironmentRow
{
    private static readonly NoVersion = '\u2014'
    private static readonly TagSeparator = ':'
    private static readonly EmptyText = ''

    private static readonly StatusPills: ReadonlyMap<EnvStatus, PillKind> = new Map<EnvStatus, PillKind>([
        [EnvStatus.Running, PillKind.Running],
        [EnvStatus.Stopped, PillKind.Stopped],
        [EnvStatus.Failed, PillKind.Failed],
        [EnvStatus.Unknown, PillKind.Unknown],
    ])

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

    public get StatusPill(): PillKind
    {
        return EnvironmentRow.StatusPills.get(this.Dto.status) ?? PillKind.Unknown
    }

    public get HealthPill(): PillKind
    {
        if (this.health === undefined)
        {
            return PillKind.Unknown
        }
        return this.health.ready ? PillKind.Healthy : PillKind.Failing
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
}
