import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { FieldGrantRow } from './field-grant-row.js'
import { SecurityModelDraft } from './security-model-draft.js'
import { TenantApiError } from './tenant-api-client.js'
import type { IRolesPrivilegesSource } from './roles-privileges-view-model.js'
import type { FieldProfileDto } from './tenant-types.js'

export enum FieldSecurityState
{
    Loading,
    Empty,
    Ready,
    Error,
    NoEnvironment,
    Forbidden,
}

// Presentation-agnostic state for the tenant admin "Field security" grid page.
export class FieldSecurityViewModel extends Observable
{
    public static readonly EnvironmentsProperty = 'Environments'
    public static readonly SelectedEnvironmentProperty = 'SelectedEnvironment'
    public static readonly ProfilesProperty = 'Profiles'
    public static readonly SelectedProfileIdProperty = 'SelectedProfileId'
    public static readonly RowsProperty = 'Rows'
    public static readonly BusyProperty = 'Busy'
    public static readonly ErrorProperty = 'Error'
    public static readonly StateProperty = 'State'
    public static readonly DirtyProperty = 'Dirty'

    private static readonly NoMessage = ''

    private environments: readonly string[] = []
    private selectedEnvironment: string | undefined
    private profiles: readonly FieldProfileDto[] = []
    private rows: readonly FieldGrantRow[] = []
    private selectedProfileId: string | undefined
    private draft: SecurityModelDraft | undefined
    private busyCount = 0
    private error = ''
    private state = FieldSecurityState.Loading
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

    public get Profiles(): readonly FieldProfileDto[]
    {
        return this.profiles
    }

    public get SelectedProfileId(): string | undefined
    {
        return this.selectedProfileId
    }

    public get Rows(): readonly FieldGrantRow[]
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

    public get State(): FieldSecurityState
    {
        return this.state
    }

    public get Dirty(): boolean
    {
        return this.dirty
    }

    public async LoadEnvironments(): Promise<void>
    {
        this.SetState(FieldSecurityState.Loading)
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
        this.RaisePropertyChanged(FieldSecurityViewModel.EnvironmentsProperty, old, this.environments)
        if (this.environments.length === 0)
        {
            this.loadToken++
            this.SetSelectedEnvironment(undefined)
            this.ResetDraft()
            this.SetState(FieldSecurityState.NoEnvironment)
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
        this.SetState(FieldSecurityState.Loading)
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

    public SelectProfile(id: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.loadToken++
        this.draft.SelectedProfileId = id
        this.Refresh()
    }

    public AddProfile(name: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.AddProfile(name)
        this.Refresh()
    }

    public DeleteProfile(id: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.DeleteProfile(id)
        this.Refresh()
    }

    public AddSecuredField(concept: string, field: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.AddSecuredField(concept, field)
        this.Refresh()
    }

    public RemoveSecuredField(concept: string, field: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.RemoveSecuredField(concept, field)
        this.Refresh()
    }

    // Cell edits go straight to the draft through FieldGrantRow; the view calls this afterwards.
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
                this.draft.SelectedProfileId = draft.SelectedProfileId
                this.Refresh()
            }
        }
        catch (e)
        {
            if (FieldSecurityViewModel.IsUnauthorized(e))
            {
                throw e
            }
            if (this.draft !== draft)
            {
                return
            }
            if (FieldSecurityViewModel.IsForbidden(e))
            {
                this.FailWith(e)
            }
            else
            {
                this.SetError(FieldSecurityViewModel.MessageOf(e))
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

    // Rebuilds Profiles/Rows/SelectedProfileId/Dirty/State from the draft.
    private Refresh(): void
    {
        const draft = this.draft
        if (draft === undefined)
        {
            return
        }
        const oldProfiles = this.profiles
        const oldRows = this.rows
        const oldProfile = this.selectedProfileId
        this.profiles = [...draft.Profiles]
        this.rows = draft.SecuredFields.map(f => new FieldGrantRow(f.concept, f.field, draft))
        this.selectedProfileId = draft.SelectedProfileId
        this.RaisePropertyChanged(FieldSecurityViewModel.ProfilesProperty, oldProfiles, this.profiles)
        this.RaisePropertyChanged(FieldSecurityViewModel.SelectedProfileIdProperty, oldProfile, this.selectedProfileId)
        this.RaisePropertyChanged(FieldSecurityViewModel.RowsProperty, oldRows, this.rows)
        this.SetDirty(draft.Dirty)
        this.SetState(this.profiles.length === 0 ? FieldSecurityState.Empty : FieldSecurityState.Ready)
    }

    private ResetDraft(): void
    {
        this.draft = undefined
        const oldProfiles = this.profiles
        const oldRows = this.rows
        const oldProfile = this.selectedProfileId
        this.profiles = []
        this.rows = []
        this.selectedProfileId = undefined
        this.RaisePropertyChanged(FieldSecurityViewModel.ProfilesProperty, oldProfiles, this.profiles)
        this.RaisePropertyChanged(FieldSecurityViewModel.SelectedProfileIdProperty, oldProfile, undefined)
        this.RaisePropertyChanged(FieldSecurityViewModel.RowsProperty, oldRows, this.rows)
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
        if (FieldSecurityViewModel.IsUnauthorized(e))
        {
            throw e
        }
        if (FieldSecurityViewModel.IsForbidden(e))
        {
            this.SetError(FieldSecurityViewModel.NoMessage)
            this.SetState(FieldSecurityState.Forbidden)
            return
        }
        this.SetError(FieldSecurityViewModel.MessageOf(e))
        this.SetState(FieldSecurityState.Error)
    }

    private SetSelectedEnvironment(value: string | undefined): void
    {
        const old = this.selectedEnvironment
        this.selectedEnvironment = value
        this.RaisePropertyChanged(FieldSecurityViewModel.SelectedEnvironmentProperty, old, value)
    }

    // Counter, not a flag: overlapping loads and saves each hold Busy until they finish.
    private EnterBusy(): void
    {
        this.busyCount++
        if (this.busyCount === 1)
        {
            this.RaisePropertyChanged(FieldSecurityViewModel.BusyProperty, false, true)
        }
    }

    private ExitBusy(): void
    {
        this.busyCount--
        if (this.busyCount === 0)
        {
            this.RaisePropertyChanged(FieldSecurityViewModel.BusyProperty, true, false)
        }
    }

    private SetDirty(value: boolean): void
    {
        const old = this.dirty
        this.dirty = value
        if (old !== value)
        {
            this.RaisePropertyChanged(FieldSecurityViewModel.DirtyProperty, old, value)
        }
    }

    private SetError(value: string): void
    {
        const old = this.error
        this.error = value
        this.RaisePropertyChanged(FieldSecurityViewModel.ErrorProperty, old, value)
    }

    private SetState(value: FieldSecurityState): void
    {
        const old = this.state
        this.state = value
        this.RaisePropertyChanged(FieldSecurityViewModel.StateProperty, old, value)
    }
}
