import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { PrivilegeRow } from './privilege-row.js'
import { SecurityModelDraft } from './security-model-draft.js'
import { TenantApiError } from './tenant-api-client.js'
import type { EnvironmentDto, ISecurityModelSource, RoleConfigDto } from './tenant-types.js'

export enum RolesPrivilegesState
{
    Loading,
    Empty,
    Ready,
    Error,
    NoEnvironment,
    Forbidden,
}

export interface IRolesPrivilegesSource extends ISecurityModelSource
{
    ListEnvironments(): Promise<EnvironmentDto[]>
}

// Presentation-agnostic state for the tenant admin "Roles & privileges" matrix page.
export class RolesPrivilegesViewModel extends Observable
{
    public static readonly EnvironmentsProperty = 'Environments'
    public static readonly SelectedEnvironmentProperty = 'SelectedEnvironment'
    public static readonly RolesProperty = 'Roles'
    public static readonly SelectedRoleIdProperty = 'SelectedRoleId'
    public static readonly RowsProperty = 'Rows'
    public static readonly BusyProperty = 'Busy'
    public static readonly ErrorProperty = 'Error'
    public static readonly StateProperty = 'State'
    public static readonly DirtyProperty = 'Dirty'

    private static readonly NoMessage = ''

    private environments: readonly string[] = []
    private selectedEnvironment: string | undefined
    private roles: readonly RoleConfigDto[] = []
    private rows: readonly PrivilegeRow[] = []
    private selectedRoleId: string | undefined
    private draft: SecurityModelDraft | undefined
    private busyCount = 0
    private error = ''
    private state = RolesPrivilegesState.Loading
    private dirty = false
    private loadToken = 0

    public constructor(private readonly source: IRolesPrivilegesSource)
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

    public get Roles(): readonly RoleConfigDto[]
    {
        return this.roles
    }

    public get SelectedRoleId(): string | undefined
    {
        return this.selectedRoleId
    }

    public get Rows(): readonly PrivilegeRow[]
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

    public get State(): RolesPrivilegesState
    {
        return this.state
    }

    public get Dirty(): boolean
    {
        return this.dirty
    }

    public async LoadEnvironments(): Promise<void>
    {
        this.SetState(RolesPrivilegesState.Loading)
        let envs
        try
        {
            envs = await this.source.ListEnvironments()
        }
        catch (e)
        {
            this.loadToken++
            this.ResetDraft()
            this.FailWith(e)
            return
        }
        const old = this.environments
        this.environments = envs.map(e => e.name)
        this.RaisePropertyChanged(RolesPrivilegesViewModel.EnvironmentsProperty, old, this.environments)
        if (this.environments.length === 0)
        {
            this.loadToken++
            this.SetSelectedEnvironment(undefined)
            this.ResetDraft()
            this.SetState(RolesPrivilegesState.NoEnvironment)
            return
        }
        await this.SelectEnvironment(this.environments[0])
    }

    public async SelectEnvironment(name: string): Promise<void>
    {
        this.SetSelectedEnvironment(name)
        this.ResetDraft()
        await this.LoadModel()
    }

    public async LoadModel(): Promise<void>
    {
        this.EnterBusy()
        try
        {
            await this.ReloadModel()
        }
        finally
        {
            this.ExitBusy()
        }
    }

    // Loads the model; a stale response (a newer load/selection started meanwhile) is discarded.
    private async ReloadModel(): Promise<void>
    {
        const env = this.selectedEnvironment
        if (env === undefined)
        {
            return
        }
        const token = ++this.loadToken
        this.SetState(RolesPrivilegesState.Loading)
        try
        {
            const model = await this.source.GetSecurityModel(env)
            if (token !== this.loadToken)
            {
                return
            }
            this.draft = SecurityModelDraft.From(model)
            this.Refresh()
            this.SetError('')
        }
        catch (e)
        {
            if (token !== this.loadToken)
            {
                return
            }
            this.ResetDraft()
            this.FailWith(e)
        }
    }

    public SelectRole(id: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.loadToken++
        this.draft.SelectedRoleId = id
        this.Refresh()
    }

    public AddRole(name: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.AddRole(name)
        this.Refresh()
    }

    public DeleteRole(id: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.DeleteRole(id)
        this.Refresh()
    }

    public AddConcept(name: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.AddConcept(name)
        this.Refresh()
    }

    // Cell edits go straight to the draft through PrivilegeRow; the view calls this afterwards.
    public RefreshDirty(): void
    {
        this.SetDirty(this.draft?.Dirty ?? false)
    }

    // Persists the draft, then rebases onto what was saved so Dirty clears.
    public async Save(): Promise<void>
    {
        const env = this.selectedEnvironment
        const draft = this.draft
        if (env === undefined || draft === undefined || this.Busy)
        {
            return
        }
        this.SetError('')
        this.EnterBusy()
        try
        {
            const dto = draft.ToDto()
            await this.source.SetSecurityModel(env, dto)
            if (this.draft === draft)
            {
                this.draft = SecurityModelDraft.From(dto)
                this.draft.SelectedRoleId = draft.SelectedRoleId
                this.Refresh()
            }
        }
        catch (e)
        {
            if (RolesPrivilegesViewModel.IsUnauthorized(e))
            {
                throw e
            }
            if (RolesPrivilegesViewModel.IsForbidden(e))
            {
                this.FailWith(e)
            }
            else
            {
                this.SetError(RolesPrivilegesViewModel.MessageOf(e))
            }
        }
        finally
        {
            this.ExitBusy()
        }
    }

    public async Revert(): Promise<void>
    {
        await this.LoadModel()
    }

    // Rebuilds Roles/Rows/SelectedRoleId/Dirty/State from the draft.
    private Refresh(): void
    {
        const draft = this.draft
        if (draft === undefined)
        {
            return
        }
        const oldRoles = this.roles
        const oldRows = this.rows
        const oldRole = this.selectedRoleId
        this.roles = [...draft.Roles]
        this.rows = draft.Concepts.map(c => new PrivilegeRow(c, draft))
        this.selectedRoleId = draft.SelectedRoleId
        this.RaisePropertyChanged(RolesPrivilegesViewModel.RolesProperty, oldRoles, this.roles)
        this.RaisePropertyChanged(RolesPrivilegesViewModel.SelectedRoleIdProperty, oldRole, this.selectedRoleId)
        this.RaisePropertyChanged(RolesPrivilegesViewModel.RowsProperty, oldRows, this.rows)
        this.SetDirty(draft.Dirty)
        this.SetState(this.roles.length === 0 ? RolesPrivilegesState.Empty : RolesPrivilegesState.Ready)
    }

    private ResetDraft(): void
    {
        this.draft = undefined
        const oldRoles = this.roles
        const oldRows = this.rows
        const oldRole = this.selectedRoleId
        this.roles = []
        this.rows = []
        this.selectedRoleId = undefined
        this.RaisePropertyChanged(RolesPrivilegesViewModel.RolesProperty, oldRoles, this.roles)
        this.RaisePropertyChanged(RolesPrivilegesViewModel.SelectedRoleIdProperty, oldRole, undefined)
        this.RaisePropertyChanged(RolesPrivilegesViewModel.RowsProperty, oldRows, this.rows)
        this.SetDirty(false)
    }

    // A 401 is not a displayable error: it propagates so the view can route to login.
    private static IsUnauthorized(e: unknown): boolean
    {
        return e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus
    }

    private static IsForbidden(e: unknown): boolean
    {
        return e instanceof TenantApiError && e.Status === TenantApiError.ForbiddenStatus
    }

    private static MessageOf(e: unknown): string
    {
        return e instanceof Error ? e.message : String(e)
    }

    private FailWith(e: unknown): void
    {
        if (RolesPrivilegesViewModel.IsUnauthorized(e))
        {
            throw e
        }
        if (RolesPrivilegesViewModel.IsForbidden(e))
        {
            this.SetError(RolesPrivilegesViewModel.NoMessage)
            this.SetState(RolesPrivilegesState.Forbidden)
            return
        }
        this.SetError(RolesPrivilegesViewModel.MessageOf(e))
        this.SetState(RolesPrivilegesState.Error)
    }

    private SetSelectedEnvironment(value: string | undefined): void
    {
        const old = this.selectedEnvironment
        this.selectedEnvironment = value
        this.RaisePropertyChanged(RolesPrivilegesViewModel.SelectedEnvironmentProperty, old, value)
    }

    // Counter, not a flag: overlapping loads and saves each hold Busy until they finish.
    private EnterBusy(): void
    {
        this.busyCount++
        if (this.busyCount === 1)
        {
            this.RaisePropertyChanged(RolesPrivilegesViewModel.BusyProperty, false, true)
        }
    }

    private ExitBusy(): void
    {
        this.busyCount--
        if (this.busyCount === 0)
        {
            this.RaisePropertyChanged(RolesPrivilegesViewModel.BusyProperty, true, false)
        }
    }

    private SetDirty(value: boolean): void
    {
        const old = this.dirty
        this.dirty = value
        if (old !== value)
        {
            this.RaisePropertyChanged(RolesPrivilegesViewModel.DirtyProperty, old, value)
        }
    }

    private SetError(value: string): void
    {
        const old = this.error
        this.error = value
        this.RaisePropertyChanged(RolesPrivilegesViewModel.ErrorProperty, old, value)
    }

    private SetState(value: RolesPrivilegesState): void
    {
        const old = this.state
        this.state = value
        this.RaisePropertyChanged(RolesPrivilegesViewModel.StateProperty, old, value)
    }
}
