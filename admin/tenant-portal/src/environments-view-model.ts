import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { EnvironmentRow } from './environment-row.js'
import { TenantApiError } from './tenant-api-client.js'
import { TenantEventType } from './tenant-types.js'
import type { EnvironmentDto, HiveHealthDto, IEnvironmentsSource, TenantEvent } from './tenant-types.js'

// Presentation-agnostic state for the tenant admin "Environments" list page.
export class EnvironmentsViewModel extends Observable
{
    public static readonly RowsProperty = 'Rows'
    public static readonly BusyProperty = 'Busy'
    public static readonly ErrorProperty = 'Error'
    public static readonly SelectionProperty = 'Selected'
    public static readonly FilterProperty = 'Filter'

    private allRows: readonly EnvironmentRow[] = []
    private filter = ''
    private selected: ReadonlySet<string> = new Set<string>()
    private busyCount = 0
    private error: string | undefined
    private loadToken = 0

    public constructor(private readonly source: IEnvironmentsSource)
    {
        super()
    }

    public get AllRows(): readonly EnvironmentRow[]
    {
        return this.allRows
    }

    public get Rows(): readonly EnvironmentRow[]
    {
        const needle = this.filter.trim().toLowerCase()
        if (needle === '')
        {
            return this.allRows
        }
        return this.allRows.filter(r => r.Name.toLowerCase().includes(needle)
            || r.EnvironmentId.toLowerCase().includes(needle)
            || r.Version.toLowerCase().includes(needle))
    }

    public get Filter(): string
    {
        return this.filter
    }

    public set Filter(value: string)
    {
        const old = this.Rows
        const oldFilter = this.filter
        this.filter = value
        this.RaisePropertyChanged(EnvironmentsViewModel.FilterProperty, oldFilter, value)
        this.RaisePropertyChanged(EnvironmentsViewModel.RowsProperty, old, this.Rows)
    }

    public get Busy(): boolean
    {
        return this.busyCount > 0
    }

    public get Error(): string | undefined
    {
        return this.error
    }

    public get Selected(): ReadonlySet<string>
    {
        return this.selected
    }

    public Toggle(name: string): void
    {
        const next = new Set(this.selected)
        if (!next.delete(name))
        {
            next.add(name)
        }
        this.SetSelected(next)
    }

    public SelectAllFiltered(): void
    {
        const next = new Set(this.selected)
        for (const r of this.Rows)
        {
            next.add(r.Name)
        }
        this.SetSelected(next)
    }

    public ClearSelection(): void
    {
        this.SetSelected(new Set<string>())
    }

    // Newer-wins: a load that finishes after a newer one started is discarded.
    public async Load(): Promise<void>
    {
        const token = ++this.loadToken
        this.EnterBusy()
        try
        {
            const envs = await this.source.ListEnvironments()
            const health = await this.LoadHealth(envs)
            if (token !== this.loadToken)
            {
                return
            }
            const old = this.Rows
            this.allRows = envs.map(e => new EnvironmentRow(e, health.get(e.name)))
            const names = new Set(this.allRows.map(r => r.Name))
            const kept = new Set([...this.selected].filter(n => names.has(n)))
            if (kept.size !== this.selected.size)
            {
                this.SetSelected(kept)
            }
            this.SetError(undefined)
            this.RaisePropertyChanged(EnvironmentsViewModel.RowsProperty, old, this.Rows)
        }
        catch (e)
        {
            if (EnvironmentsViewModel.IsUnauthorized(e))
            {
                throw e
            }
            if (token === this.loadToken)
            {
                this.SetError(EnvironmentsViewModel.MessageOf(e))
            }
        }
        finally
        {
            this.ExitBusy()
        }
    }

    public async StartSelected(): Promise<void>
    {
        await this.RunBulk(r => r.IsStopped, n => this.source.StartEnvironment(n))
    }

    public async StopSelected(): Promise<void>
    {
        await this.RunBulk(r => r.IsRunning, n => this.source.StopEnvironment(n))
    }

    public async RestartSelected(): Promise<void>
    {
        await this.RunBulk(r => r.IsRunning, n => this.source.RestartEnvironment(n))
    }

    // Returns true when the event concerned this list and a reload was triggered.
    public async ApplyEvent(ev: TenantEvent): Promise<boolean>
    {
        switch (ev.type)
        {
            case TenantEventType.EnvironmentCreated:
            case TenantEventType.HealthChanged:
                await this.SafeReload()
                return true
            case TenantEventType.EnvironmentChanged:
            case TenantEventType.EnvironmentDeleted:
                if (!this.allRows.some(r => r.Name === ev.environmentName))
                {
                    return false
                }
                await this.SafeReload()
                return true
            default:
                return false
        }
    }

    private async SafeReload(): Promise<void>
    {
        try
        {
            await this.Load()
        }
        catch
        {
            // Background event reloads are best-effort: every failure, including a 401, is swallowed.
            // Only the foreground Load path surfaces an auth failure.
        }
    }

    // Health is best-effort per hive: one hive failing degrades only its own rows, except a 401
    // (dead session), which fails the whole load.
    private async LoadHealth(envs: readonly EnvironmentDto[]): Promise<Map<string, HiveHealthDto>>
    {
        const map = new Map<string, HiveHealthDto>()
        const hives = new Set<string>()
        for (const e of envs)
        {
            if (e.hiveId !== undefined && e.hiveId !== '')
            {
                hives.add(e.hiveId)
            }
        }
        const lists = await Promise.all([...hives].map(h => this.HealthOf(h)))
        for (const list of lists)
        {
            for (const h of list)
            {
                map.set(h.environmentName, h)
            }
        }
        return map
    }

    private async HealthOf(hiveId: string): Promise<HiveHealthDto[]>
    {
        try
        {
            return await this.source.GetHealth(hiveId)
        }
        catch (e)
        {
            if (EnvironmentsViewModel.IsUnauthorized(e))
            {
                throw e
            }
            return []
        }
    }

    private async RunBulk(pick: (r: EnvironmentRow) => boolean, act: (name: string) => Promise<unknown>): Promise<void>
    {
        if (this.Busy)
        {
            return
        }
        const names = this.allRows.filter(r => this.selected.has(r.Name) && pick(r)).map(r => r.Name)
        this.SetError(undefined)
        this.EnterBusy()
        try
        {
            let firstError: string | undefined
            for (const n of names)
            {
                try
                {
                    await act(n)
                }
                catch (e)
                {
                    if (EnvironmentsViewModel.IsUnauthorized(e))
                    {
                        throw e
                    }
                    firstError ??= EnvironmentsViewModel.MessageOf(e)
                }
            }
            this.ClearSelection()
            await this.Load()
            if (firstError !== undefined)
            {
                this.SetError(firstError)
            }
        }
        finally
        {
            this.ExitBusy()
        }
    }

    private SetSelected(next: ReadonlySet<string>): void
    {
        const old = this.selected
        this.selected = next
        this.RaisePropertyChanged(EnvironmentsViewModel.SelectionProperty, old, next)
    }

    private SetError(value: string | undefined): void
    {
        const old = this.error
        this.error = value
        if (old !== value)
        {
            this.RaisePropertyChanged(EnvironmentsViewModel.ErrorProperty, old, value)
        }
    }

    private static IsUnauthorized(e: unknown): boolean
    {
        return e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus
    }

    private static MessageOf(e: unknown): string
    {
        return e instanceof Error ? e.message : String(e)
    }

    private EnterBusy(): void
    {
        this.busyCount++
        if (this.busyCount === 1)
        {
            this.RaisePropertyChanged(EnvironmentsViewModel.BusyProperty, false, true)
        }
    }

    private ExitBusy(): void
    {
        this.busyCount--
        if (this.busyCount === 0)
        {
            this.RaisePropertyChanged(EnvironmentsViewModel.BusyProperty, true, false)
        }
    }
}
