import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { EnvironmentDto, HiveHealthDto, TenantEvent } from './tenant-types.js'

// The slice of TenantApiClient the environment detail needs.
export interface IEnvDetailSource
{
    StartEnvironment(name: string): Promise<EnvironmentDto>
    StopEnvironment(name: string): Promise<EnvironmentDto>
    RestartEnvironment(name: string): Promise<EnvironmentDto>
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
    public static readonly MaxLogChars = 100_000

    private status: string
    private runningVersion = ''
    private type: string
    private health: HiveHealthDto | undefined
    private logBuffer = ''
    private paused = false
    private disposeLogs: (() => void) | undefined

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

    public get RunningVersion(): string
    {
        return this.runningVersion
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
        if (this.health?.runningImage !== undefined)
        {
            this.runningVersion = this.health.runningImage
        }
        this.RaisePropertyChanged(EnvironmentDetailViewModel.HealthProperty, old, this.health)
    }

    public StartLogs(): void
    {
        if (this.disposeLogs !== undefined)
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

    public StopLogs(): void
    {
        const dispose = this.disposeLogs
        this.disposeLogs = undefined
        dispose?.()
    }

    public async ApplyEvent(ev: TenantEvent): Promise<boolean>
    {
        if (ev.environmentName !== this.env.name)
        {
            return false
        }
        // A failed live refresh is intentionally ignored: the next event or Refresh recovers.
        await this.LoadHealth().catch(() => undefined)
        return true
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
