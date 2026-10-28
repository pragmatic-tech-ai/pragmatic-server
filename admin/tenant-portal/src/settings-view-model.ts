import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantApiError } from './tenant-api-client.js'
import type { HiveDto, TenantProfileDto } from './tenant-types.js'

export interface ISettingsSource
{
    Profile(): Promise<TenantProfileDto>
    ListHives(): Promise<HiveDto[]>
}

export enum SettingsState
{
    Loading,
    Ready,
    NoData,
    Error,
    Forbidden,
}

// Presentation-agnostic state for the read-only Settings page (profile + the tenant's one hive).
export class SettingsViewModel extends Observable
{
    public static readonly StateProperty = 'State'
    public static readonly ProfileProperty = 'Profile'
    public static readonly HiveProperty = 'Hive'
    public static readonly ErrorProperty = 'Error'

    private static readonly NoMessage = ''

    private state = SettingsState.Loading
    private profile: TenantProfileDto | undefined
    private hive: HiveDto | undefined
    private error = SettingsViewModel.NoMessage
    private loadToken = 0

    public constructor(private readonly source: ISettingsSource)
    {
        super()
    }

    public get State(): SettingsState
    {
        return this.state
    }

    public get Profile(): TenantProfileDto | undefined
    {
        return this.profile
    }

    public get Hive(): HiveDto | undefined
    {
        return this.hive
    }

    public get Error(): string
    {
        return this.error
    }

    public async Load(): Promise<void>
    {
        const token = ++this.loadToken
        this.SetError(SettingsViewModel.NoMessage)
        this.SetState(SettingsState.Loading)
        try
        {
            const profile = await this.source.Profile()
            const hives = await this.source.ListHives()
            if (token !== this.loadToken)
            {
                return
            }
            // A tenant has exactly one hive.
            this.SetHive(hives[0])
            this.SetProfile(profile ?? undefined)
            this.SetState(profile === undefined || profile === null ? SettingsState.NoData : SettingsState.Ready)
        }
        catch (e)
        {
            if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
            {
                throw e
            }
            if (token !== this.loadToken)
            {
                return
            }
            this.Fail(e)
        }
    }

    private Fail(e: unknown): void
    {
        this.SetProfile(undefined)
        this.SetHive(undefined)
        if (e instanceof TenantApiError && e.Status === TenantApiError.ForbiddenStatus)
        {
            this.SetState(SettingsState.Forbidden)
        }
        else
        {
            this.SetError(e instanceof Error ? e.message : String(e))
            this.SetState(SettingsState.Error)
        }
    }

    private SetProfile(value: TenantProfileDto | undefined): void
    {
        const old = this.profile
        this.profile = value
        this.RaisePropertyChanged(SettingsViewModel.ProfileProperty, old, value)
    }

    private SetHive(value: HiveDto | undefined): void
    {
        const old = this.hive
        this.hive = value
        this.RaisePropertyChanged(SettingsViewModel.HiveProperty, old, value)
    }

    private SetError(value: string): void
    {
        const old = this.error
        this.error = value
        this.RaisePropertyChanged(SettingsViewModel.ErrorProperty, old, value)
    }

    private SetState(value: SettingsState): void
    {
        const old = this.state
        this.state = value
        this.RaisePropertyChanged(SettingsViewModel.StateProperty, old, value)
    }
}
