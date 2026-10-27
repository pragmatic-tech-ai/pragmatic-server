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
    public static readonly PendingProperty = 'Pending'

    public DraftEmail = ''
    public DraftPrincipalId = ''
    public DraftPassword = ''
    public DraftRole: TenantRole = TenantRole.Viewer

    private environments: readonly string[] = []
    private selectedEnvironment: string | undefined
    private rows: readonly AccountRow[] = []
    private grants: readonly GrantDto[] = []
    private busy = false
    private error = ''
    private state = UsersAccessState.Loading
    private selectedPrincipalId: string | undefined
    private pending: PendingAction | undefined
    private pendingGrant: GrantDto | undefined

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
        return this.busy
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
            this.FailWith(e)
            return
        }
        const old = this.environments
        this.environments = envs.map(e => e.name)
        this.RaisePropertyChanged(UsersAccessViewModel.EnvironmentsProperty, old, this.environments)
        if (this.environments.length === 0)
        {
            this.SetSelectedEnvironment(undefined)
            this.SetState(UsersAccessState.NoEnvironment)
            return
        }
        await this.SelectEnvironment(this.environments[0])
    }

    public async SelectEnvironment(name: string): Promise<void>
    {
        this.SetSelectedEnvironment(name)
        await this.LoadSnapshot()
    }

    public async LoadSnapshot(): Promise<void>
    {
        const env = this.selectedEnvironment
        if (env === undefined)
        {
            return
        }
        this.SetState(UsersAccessState.Loading)
        this.SetBusy(true)
        try
        {
            const snapshot = await this.source.GetAdminSnapshot(env)
            const oldRows = this.rows
            this.rows = AccountRow.FromSnapshot(snapshot)
            this.grants = snapshot.grants
            this.RaisePropertyChanged(UsersAccessViewModel.RowsProperty, oldRows, this.rows)
            const sel = this.selectedPrincipalId
            if (sel !== undefined && !this.rows.some(r => r.PrincipalId === sel))
            {
                this.SetSelectedPrincipalId(undefined)
            }
            this.SetError('')
            this.SetState(this.rows.length === 0 ? UsersAccessState.Empty : UsersAccessState.Ready)
        }
        catch (e)
        {
            this.FailWith(e)
        }
        finally
        {
            this.SetBusy(false)
        }
    }

    public SelectAccount(principalId: string | undefined): void
    {
        this.SetSelectedPrincipalId(principalId)
    }

    public async CreateAccount(): Promise<void>
    {
        const params = { email: this.DraftEmail, principalId: this.DraftPrincipalId, password: this.DraftPassword }
        const ok = await this.Mutate(env => this.source.CreateAccount(env, params))
        if (!ok)
        {
            return
        }
        this.DraftEmail = ''
        this.DraftPrincipalId = ''
        this.DraftPassword = ''
        await this.LoadSnapshot()
    }

    public RequestDisable(principalId: string): void
    {
        if (principalId === this.currentPrincipalId)
        {
            this.pendingGrant = undefined
            this.SetPending({ kind: PendingKind.DisableSelf, principalId })
            return
        }
        void this.DisableAccount(principalId)
    }

    public RequestRevoke(grant: GrantDto): void
    {
        if (grant.subject === this.currentPrincipalId)
        {
            this.pendingGrant = grant
            this.SetPending({ kind: PendingKind.RevokeSelf, principalId: grant.subject, role: grant.role })
            return
        }
        void this.RevokeRole(grant)
    }

    public async ConfirmPending(): Promise<void>
    {
        const pending = this.pending
        const grant = this.pendingGrant
        if (pending === undefined)
        {
            return
        }
        this.pendingGrant = undefined
        this.SetPending(undefined)
        if (pending.kind === PendingKind.RevokeSelf && grant !== undefined)
        {
            await this.RevokeRole(grant)
        }
        else
        {
            await this.DisableAccount(pending.principalId)
        }
    }

    public CancelPending(): void
    {
        this.pendingGrant = undefined
        this.SetPending(undefined)
    }

    public async DisableAccount(principalId: string): Promise<void>
    {
        if (await this.Mutate(env => this.source.DisableAccount(env, principalId)))
        {
            await this.LoadSnapshot()
        }
    }

    public async GrantRole(): Promise<void>
    {
        const subject = this.selectedPrincipalId
        if (subject === undefined)
        {
            return
        }
        const grant = { subject, role: this.DraftRole }
        if (await this.Mutate(env => this.source.GrantRole(env, grant)))
        {
            await this.LoadSnapshot()
        }
    }

    public async RevokeRole(grant: GrantDto): Promise<void>
    {
        const body = { subject: grant.subject, role: grant.role, resourceKind: grant.resourceKind, resourcePath: grant.resourcePath }
        if (await this.Mutate(env => this.source.RevokeRole(env, body)))
        {
            await this.LoadSnapshot()
        }
    }

    // Runs one mutating call; a TenantApiError surfaces as Error and returns false (no reload).
    private async Mutate(call: (env: string) => Promise<void>): Promise<boolean>
    {
        const env = this.selectedEnvironment
        if (env === undefined)
        {
            return false
        }
        this.SetError('')
        this.SetBusy(true)
        try
        {
            await call(env)
            return true
        }
        catch (e)
        {
            if (e instanceof TenantApiError)
            {
                this.SetError(e.message)
                return false
            }
            throw e
        }
        finally
        {
            this.SetBusy(false)
        }
    }

    private FailWith(e: unknown): void
    {
        if (!(e instanceof TenantApiError))
        {
            throw e
        }
        this.SetError(e.message)
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

    private SetBusy(value: boolean): void
    {
        const old = this.busy
        this.busy = value
        this.RaisePropertyChanged(UsersAccessViewModel.BusyProperty, old, value)
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
