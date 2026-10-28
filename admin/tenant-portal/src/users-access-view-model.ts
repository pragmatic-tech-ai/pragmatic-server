import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { AccountRow } from './account-row.js'
import { TenantApiError } from './tenant-api-client.js'
import { TenantRole } from './tenant-types.js'
import type { GrantDto, IUsersAccessSource } from './tenant-types.js'

export enum UsersAccessState
{
    Loading,
    Empty,
    Ready,
    Error,
    NoEnvironment,
}

export enum PendingKind
{
    DisableSelf,
    RevokeSelf,
}

export type PendingAction = { kind: PendingKind; principalId: string; role?: string }

// Presentation-agnostic state for the tenant admin "Users & Access" page.
export class UsersAccessViewModel extends Observable
{
    public static readonly EnvironmentsProperty = 'Environments'
    public static readonly SelectedEnvironmentProperty = 'SelectedEnvironment'
    public static readonly RowsProperty = 'Rows'
    public static readonly BusyProperty = 'Busy'
    public static readonly ErrorProperty = 'Error'
    public static readonly StateProperty = 'State'
    public static readonly SelectedPrincipalIdProperty = 'SelectedPrincipalId'
    private static readonly EmptyDraft = ''
    public static readonly PendingProperty = 'Pending'
    public static readonly SelectedGrantsProperty = 'SelectedGrants'

    public DraftEmail = UsersAccessViewModel.EmptyDraft
    public DraftPrincipalId = UsersAccessViewModel.EmptyDraft
    public DraftPassword = UsersAccessViewModel.EmptyDraft
    public DraftRole: TenantRole = TenantRole.Viewer

    private environments: readonly string[] = []
    private selectedEnvironment: string | undefined
    private rows: readonly AccountRow[] = []
    private grants: readonly GrantDto[] = []
    private busyCount = 0
    private error = ''
    private state = UsersAccessState.Loading
    private selectedPrincipalId: string | undefined
    private pending: PendingAction | undefined
    private pendingGrant: GrantDto | undefined
    private loadToken = 0

    public constructor(private readonly source: IUsersAccessSource, private readonly currentPrincipalId: string)
    {
        super()
    }

    public get Environments(): readonly string[]
    {
        return this.environments
    }

    public get SelectedEnvironment(): string | undefined
    {
        return this.selectedEnvironment
    }

    public get Rows(): readonly AccountRow[]
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

    public get State(): UsersAccessState
    {
        return this.state
    }

    public get SelectedPrincipalId(): string | undefined
    {
        return this.selectedPrincipalId
    }

    public get SelectedGrants(): readonly GrantDto[]
    {
        const id = this.selectedPrincipalId
        return id === undefined ? [] : this.grants.filter(g => g.subject === id)
    }

    // The grant a pending RevokeSelf targets (full identity), for display matching.
    public get PendingGrant(): GrantDto | undefined
    {
        return this.pendingGrant
    }

    public get CurrentPrincipalId(): string
    {
        return this.currentPrincipalId
    }

    public get Pending(): PendingAction | undefined
    {
        return this.pending
    }

    public async LoadEnvironments(): Promise<void>
    {
        this.SetState(UsersAccessState.Loading)
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
        this.RaisePropertyChanged(UsersAccessViewModel.EnvironmentsProperty, old, this.environments)
        if (this.environments.length === 0)
        {
            this.loadToken++
            this.SetSelectedEnvironment(undefined)
            this.ClearRows()
            this.SetState(UsersAccessState.NoEnvironment)
            return
        }
        await this.SelectEnvironment(this.environments[0])
    }

    public async SelectEnvironment(name: string): Promise<void>
    {
        this.CancelPending()
        this.SetSelectedEnvironment(name)
        await this.LoadSnapshot()
    }

    public async LoadSnapshot(): Promise<void>
    {
        this.EnterBusy()
        try
        {
            await this.ReloadSnapshot()
        }
        finally
        {
            this.ExitBusy()
        }
    }

    // Loads the snapshot; a stale response (a newer load started meanwhile) is discarded.
    private async ReloadSnapshot(): Promise<void>
    {
        const env = this.selectedEnvironment
        if (env === undefined)
        {
            return
        }
        const token = ++this.loadToken
        this.SetState(UsersAccessState.Loading)
        try
        {
            const snapshot = await this.source.GetAdminSnapshot(env)
            if (token !== this.loadToken)
            {
                return
            }
            const oldRows = this.rows
            const oldGrants = this.SelectedGrants
            this.rows = AccountRow.FromSnapshot(snapshot)
            this.grants = snapshot.grants
            this.RaisePropertyChanged(UsersAccessViewModel.RowsProperty, oldRows, this.rows)
            const sel = this.selectedPrincipalId
            if (sel !== undefined && !this.rows.some(r => r.PrincipalId === sel))
            {
                this.SetSelectedPrincipalId(undefined)
            }
            this.RaisePropertyChanged(UsersAccessViewModel.SelectedGrantsProperty, oldGrants, this.SelectedGrants)
            this.SetError('')
            this.SetState(this.rows.length === 0 ? UsersAccessState.Empty : UsersAccessState.Ready)
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

    public SelectAccount(principalId: string | undefined): void
    {
        const oldGrants = this.SelectedGrants
        this.SetSelectedPrincipalId(principalId)
        this.RaisePropertyChanged(UsersAccessViewModel.SelectedGrantsProperty, oldGrants, this.SelectedGrants)
    }

    public async CreateAccount(): Promise<void>
    {
        const params = { email: this.DraftEmail, principalId: this.DraftPrincipalId, password: this.DraftPassword }
        await this.Mutate(async env =>
        {
            await this.source.CreateAccount(env, params)
            this.DraftEmail = UsersAccessViewModel.EmptyDraft
            this.DraftPrincipalId = UsersAccessViewModel.EmptyDraft
            this.DraftPassword = UsersAccessViewModel.EmptyDraft
        })
    }

    public RequestDisable(principalId: string): Promise<void>
    {
        if (principalId === this.currentPrincipalId)
        {
            this.pendingGrant = undefined
            this.SetPending({ kind: PendingKind.DisableSelf, principalId })
            return Promise.resolve()
        }
        return this.DisableAccount(principalId)
    }

    public RequestRevoke(grant: GrantDto): Promise<void>
    {
        if (grant.subject === this.currentPrincipalId)
        {
            this.pendingGrant = grant
            this.SetPending({ kind: PendingKind.RevokeSelf, principalId: grant.subject, role: grant.role })
            return Promise.resolve()
        }
        return this.RevokeRole(grant)
    }

    public async ConfirmPending(): Promise<void>
    {
        const pending = this.pending
        const grant = this.pendingGrant
        if (pending === undefined || this.Busy)
        {
            return
        }
        this.pendingGrant = undefined
        this.SetPending(undefined)
        switch (pending.kind)
        {
            case PendingKind.DisableSelf:
                await this.DisableAccount(pending.principalId)
                return
            case PendingKind.RevokeSelf:
                if (grant !== undefined)
                {
                    await this.RevokeRole(grant)
                }
                return
        }
    }

    public CancelPending(): void
    {
        this.pendingGrant = undefined
        this.SetPending(undefined)
    }

    public async DisableAccount(principalId: string): Promise<void>
    {
        await this.Mutate(env => this.source.DisableAccount(env, principalId))
    }

    public async GrantRole(): Promise<void>
    {
        const subject = this.selectedPrincipalId
        if (subject === undefined)
        {
            return
        }
        const grant = { subject, role: this.DraftRole }
        await this.Mutate(env => this.source.GrantRole(env, grant))
    }

    public async RevokeRole(grant: GrantDto): Promise<void>
    {
        const body = { subject: grant.subject, role: grant.role, resourceKind: grant.resourceKind, resourcePath: grant.resourcePath }
        await this.Mutate(env => this.source.RevokeRole(env, body))
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
            await this.ReloadSnapshot()
        }
        catch (e)
        {
            if (UsersAccessViewModel.IsUnauthorized(e))
            {
                throw e
            }
            this.SetError(UsersAccessViewModel.MessageOf(e))
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
        const oldGrants = this.SelectedGrants
        this.rows = []
        this.grants = []
        this.RaisePropertyChanged(UsersAccessViewModel.RowsProperty, oldRows, this.rows)
        this.RaisePropertyChanged(UsersAccessViewModel.SelectedGrantsProperty, oldGrants, this.SelectedGrants)
    }

    private FailWith(e: unknown): void
    {
        if (UsersAccessViewModel.IsUnauthorized(e))
        {
            throw e
        }
        this.SetError(UsersAccessViewModel.MessageOf(e))
        this.SetState(UsersAccessState.Error)
    }

    private SetSelectedEnvironment(value: string | undefined): void
    {
        const old = this.selectedEnvironment
        this.selectedEnvironment = value
        this.RaisePropertyChanged(UsersAccessViewModel.SelectedEnvironmentProperty, old, value)
    }

    private SetSelectedPrincipalId(value: string | undefined): void
    {
        const old = this.selectedPrincipalId
        this.selectedPrincipalId = value
        this.RaisePropertyChanged(UsersAccessViewModel.SelectedPrincipalIdProperty, old, value)
    }

    private SetPending(value: PendingAction | undefined): void
    {
        const old = this.pending
        this.pending = value
        this.RaisePropertyChanged(UsersAccessViewModel.PendingProperty, old, value)
    }

    // Counter, not a flag: overlapping loads and mutations each hold Busy until they finish.
    private EnterBusy(): void
    {
        this.busyCount++
        if (this.busyCount === 1)
        {
            this.RaisePropertyChanged(UsersAccessViewModel.BusyProperty, false, true)
        }
    }

    private ExitBusy(): void
    {
        this.busyCount--
        if (this.busyCount === 0)
        {
            this.RaisePropertyChanged(UsersAccessViewModel.BusyProperty, true, false)
        }
    }

    private SetError(value: string): void
    {
        const old = this.error
        this.error = value
        this.RaisePropertyChanged(UsersAccessViewModel.ErrorProperty, old, value)
    }

    private SetState(value: UsersAccessState): void
    {
        const old = this.state
        this.state = value
        this.RaisePropertyChanged(UsersAccessViewModel.StateProperty, old, value)
    }
}
