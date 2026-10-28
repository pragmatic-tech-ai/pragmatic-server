import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { EnvironmentRow } from './environment-row.js'
import type { EnvStatus, EnvironmentDto, HiveHealthDto, Template } from './tenant-types.js'

// The slice of TenantApiClient the environment detail needs.
export interface IEnvDetailSource
{
    StartEnvironment(name: string): Promise<EnvironmentDto>
    StopEnvironment(name: string): Promise<EnvironmentDto>
    RestartEnvironment(name: string): Promise<EnvironmentDto>
    DeleteEnvironment(name: string): Promise<void>
    GetHealth(hiveId: string): Promise<HiveHealthDto[]>
    OpenLogStream(name: string, onChunk: (t: string) => void): () => void
}

// One environment: lifecycle, its health row, and a bounded, pausable live log buffer.
export class EnvironmentDetailViewModel extends Observable
{
    public static readonly StatusProperty = 'Status'
    public static readonly HealthProperty = 'Health'
    public static readonly LogBufferProperty = 'LogBuffer'
    public static readonly PausedProperty = 'Paused'
    private static readonly EmptyText = ''
    private static readonly NoUiBundleText = 'No UI bundle deployed yet'
    private static readonly NotFederatedText = 'Not federated'
    private static readonly BundleSeparator = ' '
    private static readonly HostSeparator = '.'
    public static readonly MaxLogChars = 100_000

    private status: string
    private type: string
    private health: HiveHealthDto | undefined
    private logBuffer = ''
    private paused = false
    private disposeLogs: (() => void) | undefined
    private disposed = false

    public constructor(private readonly source: IEnvDetailSource, private readonly env: EnvironmentDto, private readonly hiveId: string | undefined)
    {
        super()
        this.status = env.status
        this.type = env.type
    }

    public get Status(): string
    {
        return this.status
    }

    public get Name(): string
    {
        return this.env.name
    }

    public get Template(): Template
    {
        return this.env.template
    }

    public get EnvironmentId(): string
    {
        return this.env.environmentId
    }

    public get CreatedAt(): string
    {
        return this.env.createdAt
    }

    // Live: derived from the current status, not the construction-time one.
    public get LiveUrl(): string
    {
        return EnvironmentRow.UrlOf(this.status as EnvStatus, this.env.httpUrl) ?? EnvironmentDetailViewModel.EmptyText
    }

    public get HasUiBundle(): boolean
    {
        return this.env.uiBundle !== undefined
    }

    public get UiBundleText(): string
    {
        const b = this.env.uiBundle
        return b === undefined ? EnvironmentDetailViewModel.NoUiBundleText : b.appName + EnvironmentDetailViewModel.BundleSeparator + b.appVersion
    }

    public get SignInAddress(): string
    {
        const d = this.env.idpBaseDomain
        return d === undefined ? EnvironmentDetailViewModel.NotFederatedText : this.env.environmentId + EnvironmentDetailViewModel.HostSeparator + d
    }

    public get Version(): string
    {
        return EnvironmentRow.VersionOf(this.health?.runningImage)
    }

    public get Type(): string
    {
        return this.type
    }

    public get Health(): HiveHealthDto | undefined
    {
        return this.health
    }

    public get LogBuffer(): string
    {
        return this.logBuffer
    }

    public get Paused(): boolean
    {
        return this.paused
    }

    public async Delete(): Promise<void>
    {
        await this.source.DeleteEnvironment(this.env.name)
    }

    public async Start(): Promise<void>
    {
        this.ApplyDto(await this.source.StartEnvironment(this.env.name))
    }

    public async Stop(): Promise<void>
    {
        this.ApplyDto(await this.source.StopEnvironment(this.env.name))
    }

    public async Restart(): Promise<void>
    {
        this.ApplyDto(await this.source.RestartEnvironment(this.env.name))
    }

    // An env not bound to a hive has no health row; leave Health undefined.
    public async LoadHealth(): Promise<void>
    {
        if (this.hiveId === undefined)
        {
            return
        }
        const rows = await this.source.GetHealth(this.hiveId)
        const old = this.health
        this.health = rows.find(r => r.environmentName === this.env.name)
        this.RaisePropertyChanged(EnvironmentDetailViewModel.HealthProperty, old, this.health)
    }

    public StartLogs(): void
    {
        if (this.disposed || this.disposeLogs !== undefined)
        {
            return
        }
        this.disposeLogs = this.source.OpenLogStream(this.env.name, chunk => this.AppendLog(chunk))
    }

    // Pausing only stops appending; the socket stays open.
    public TogglePause(): void
    {
        const old = this.paused
        this.paused = !old
        this.RaisePropertyChanged(EnvironmentDetailViewModel.PausedProperty, old, this.paused)
    }

    // Latches disposed: a StartLogs racing in after teardown must not open a socket nothing closes.
    public StopLogs(): void
    {
        this.disposed = true
        const dispose = this.disposeLogs
        this.disposeLogs = undefined
        dispose?.()
    }

    private AppendLog(chunk: string): void
    {
        if (this.paused || this.disposeLogs === undefined)
        {
            return
        }
        const old = this.logBuffer
        const max = EnvironmentDetailViewModel.MaxLogChars
        const next = old + chunk
        this.logBuffer = next.length > max ? next.slice(next.length - max) : next
        this.RaisePropertyChanged(EnvironmentDetailViewModel.LogBufferProperty, old, this.logBuffer)
    }

    private ApplyDto(dto: EnvironmentDto): void
    {
        const old = this.status
        this.status = dto.status
        this.type = dto.type
        this.RaisePropertyChanged(EnvironmentDetailViewModel.StatusProperty, old, this.status)
    }
}
