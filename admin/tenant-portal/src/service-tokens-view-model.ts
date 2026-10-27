import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ServiceTokenRow } from './service-token-row.js'
import { TenantApiError } from './tenant-api-client.js'
import type { ITokensSource, TokenIssuedDto } from './tenant-types.js'

export enum TokenDuration
{
    OneHour,
    OneDay,
    ThirtyDays,
    Never,
}

export enum TokensState
{
    Loading,
    Empty,
    Ready,
    Error,
    NoEnvironment,
}

// Presentation-agnostic state for the tenant admin "Service Tokens" page.
export class ServiceTokensViewModel extends Observable
{
    public static readonly EnvironmentsProperty = 'Environments'
    public static readonly SelectedEnvironmentProperty = 'SelectedEnvironment'
    public static readonly RowsProperty = 'Rows'
    public static readonly BusyProperty = 'Busy'
    public static readonly ErrorProperty = 'Error'
    public static readonly StateProperty = 'State'
    public static readonly IssuedSecretProperty = 'IssuedSecret'
    public static readonly PendingProperty = 'Pending'
    private static readonly EmptyDraft = ''
    private static readonly ScopeSplitter = /[\s,]+/
    private static readonly ScopesRequiredMessage = 'At least one scope is required.'
    private static readonly SecondsByDuration: ReadonlyMap<TokenDuration, number | null> = new Map<TokenDuration, number | null>([
        [TokenDuration.OneHour, 3600],
        [TokenDuration.OneDay, 86400],
        [TokenDuration.ThirtyDays, 2592000],
        [TokenDuration.Never, null],
    ])

    public DraftPrincipalId = ServiceTokensViewModel.EmptyDraft
    public DraftScopes = ServiceTokensViewModel.EmptyDraft
    public DraftDuration: TokenDuration = TokenDuration.OneDay

    private environments: readonly string[] = []
    private selectedEnvironment: string | undefined
    private rows: readonly ServiceTokenRow[] = []
    private busyCount = 0
    private error = ''
    private state = TokensState.Loading
    private issuedSecret: TokenIssuedDto | undefined
    private pending: string | undefined
    private loadToken = 0

    public constructor(private readonly source: ITokensSource)
    {
        super()
    }

    public static SecondsFor(duration: TokenDuration): number | null
    {
        return ServiceTokensViewModel.SecondsByDuration.get(duration) ?? null
    }

    public get Environments(): readonly string[]
    {
        return this.environments
    }

    public get SelectedEnvironment(): string | undefined
    {
        return this.selectedEnvironment
    }

    public get Rows(): readonly ServiceTokenRow[]
    {
        return this.rows
    }

    public get Busy(): boolean
    {
        return this.busyCount > 0
    }

    public get Error(): string
    {
        return this.error
    }

    public get State(): TokensState
    {
        return this.state
    }

    public get IssuedSecret(): TokenIssuedDto | undefined
    {
        return this.issuedSecret
    }

    public get Pending(): string | undefined
    {
        return this.pending
    }

    public async LoadEnvironments(): Promise<void>
    {
        this.SetState(TokensState.Loading)
        let envs
        try
        {
            envs = await this.source.ListEnvironments()
        }
        catch (e)
        {
            this.loadToken++
            this.ClearRows()
            this.FailWith(e)
            return
        }
        const old = this.environments
        this.environments = envs.map(e => e.name)
        this.RaisePropertyChanged(ServiceTokensViewModel.EnvironmentsProperty, old, this.environments)
        if (this.environments.length === 0)
        {
            this.loadToken++
            this.SetSelectedEnvironment(undefined)
            this.ClearRows()
            this.SetState(TokensState.NoEnvironment)
            return
        }
        await this.SelectEnvironment(this.environments[0])
    }

    public async SelectEnvironment(name: string): Promise<void>
    {
        this.CancelPending()
        this.SetSelectedEnvironment(name)
        await this.LoadTokens()
    }

    public async LoadTokens(): Promise<void>
    {
        this.EnterBusy()
        try
        {
            await this.ReloadTokens()
        }
        finally
        {
            this.ExitBusy()
        }
    }

    // Loads the list; a stale response (a newer load started meanwhile) is discarded.
    private async ReloadTokens(): Promise<void>
    {
        const env = this.selectedEnvironment
        if (env === undefined)
        {
            return
        }
        const token = ++this.loadToken
        this.SetState(TokensState.Loading)
        try
        {
            const dtos = await this.source.ListTokens(env)
            if (token !== this.loadToken)
            {
                return
            }
            const oldRows = this.rows
            this.rows = ServiceTokenRow.FromDtos(dtos)
            this.RaisePropertyChanged(ServiceTokensViewModel.RowsProperty, oldRows, this.rows)
            this.SetError('')
            this.SetState(this.rows.length === 0 ? TokensState.Empty : TokensState.Ready)
        }
        catch (e)
        {
            if (token !== this.loadToken)
            {
                return
            }
            this.ClearRows()
            this.FailWith(e)
        }
    }

    public async IssueToken(): Promise<void>
    {
        const scopes = this.DraftScopes.split(ServiceTokensViewModel.ScopeSplitter).filter(s => s.length > 0)
        if (scopes.length === 0)
        {
            this.SetError(ServiceTokensViewModel.ScopesRequiredMessage)
            return
        }
        const params = {
            principalId: this.DraftPrincipalId,
            scopes,
            expiresInSeconds: ServiceTokensViewModel.SecondsFor(this.DraftDuration),
        }
        await this.Mutate(async env =>
        {
            const issued = await this.source.IssueToken(env, params)
            this.SetIssuedSecret(issued)
            this.DraftPrincipalId = ServiceTokensViewModel.EmptyDraft
            this.DraftScopes = ServiceTokensViewModel.EmptyDraft
        })
    }

    public DismissSecret(): void
    {
        this.SetIssuedSecret(undefined)
    }

    public RequestRevoke(tokenRef: string): void
    {
        this.SetPending(tokenRef)
    }

    public async ConfirmPending(): Promise<void>
    {
        const ref = this.pending
        if (ref === undefined || this.Busy)
        {
            return
        }
        this.SetPending(undefined)
        await this.Mutate(env => this.source.RevokeToken(env, ref))
    }

    public CancelPending(): void
    {
        this.SetPending(undefined)
    }

    // Runs one mutating call plus its follow-on reload under a single Busy span. No-op while Busy.
    // Any failure surfaces as Error with no reload; Rows stay as they were.
    private async Mutate(call: (env: string) => Promise<void>): Promise<void>
    {
        const env = this.selectedEnvironment
        if (env === undefined || this.Busy)
        {
            return
        }
        this.SetError('')
        this.EnterBusy()
        try
        {
            await call(env)
            await this.ReloadTokens()
        }
        catch (e)
        {
            if (ServiceTokensViewModel.IsUnauthorized(e))
            {
                throw e
            }
            this.SetError(ServiceTokensViewModel.MessageOf(e))
        }
        finally
        {
            this.ExitBusy()
        }
    }

    // A 401 is not a displayable error: it propagates so the view can route to login.
    private static IsUnauthorized(e: unknown): boolean
    {
        return e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus
    }

    private static MessageOf(e: unknown): string
    {
        return e instanceof Error ? e.message : String(e)
    }

    private ClearRows(): void
    {
        const oldRows = this.rows
        this.rows = []
        this.RaisePropertyChanged(ServiceTokensViewModel.RowsProperty, oldRows, this.rows)
    }

    private FailWith(e: unknown): void
    {
        if (ServiceTokensViewModel.IsUnauthorized(e))
        {
            throw e
        }
        this.SetError(ServiceTokensViewModel.MessageOf(e))
        this.SetState(TokensState.Error)
    }

    private SetSelectedEnvironment(value: string | undefined): void
    {
        const old = this.selectedEnvironment
        this.selectedEnvironment = value
        this.RaisePropertyChanged(ServiceTokensViewModel.SelectedEnvironmentProperty, old, value)
    }

    private SetIssuedSecret(value: TokenIssuedDto | undefined): void
    {
        const old = this.issuedSecret
        this.issuedSecret = value
        this.RaisePropertyChanged(ServiceTokensViewModel.IssuedSecretProperty, old, value)
    }

    private SetPending(value: string | undefined): void
    {
        const old = this.pending
        this.pending = value
        this.RaisePropertyChanged(ServiceTokensViewModel.PendingProperty, old, value)
    }

    // Counter, not a flag: overlapping loads and mutations each hold Busy until they finish.
    private EnterBusy(): void
    {
        this.busyCount++
        if (this.busyCount === 1)
        {
            this.RaisePropertyChanged(ServiceTokensViewModel.BusyProperty, false, true)
        }
    }

    private ExitBusy(): void
    {
        this.busyCount--
        if (this.busyCount === 0)
        {
            this.RaisePropertyChanged(ServiceTokensViewModel.BusyProperty, true, false)
        }
    }

    private SetError(value: string): void
    {
        const old = this.error
        this.error = value
        this.RaisePropertyChanged(ServiceTokensViewModel.ErrorProperty, old, value)
    }

    private SetState(value: TokensState): void
    {
        const old = this.state
        this.state = value
        this.RaisePropertyChanged(ServiceTokensViewModel.StateProperty, old, value)
    }
}
