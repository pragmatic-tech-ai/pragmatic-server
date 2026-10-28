import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { BusinessUnitRow } from './business-unit-row.js'
import { FieldGrantRow } from './field-grant-row.js'
import { MembershipOverrideRow } from './membership-override-row.js'
import { MembershipRuleRow } from './membership-rule-row.js'
import { OwnershipRuleRow } from './ownership-rule-row.js'
import { PrivilegeRow } from './privilege-row.js'
import type { RecordSharingRowData } from './record-sharing.js'
import { SecurityModelDraft } from './security-model-draft.js'
import { TeamRow } from './team-row.js'
import { TenantApiError } from './tenant-api-client.js'
import type { EnvironmentDto, FieldProfileDto, ISecurityModelSource, RoleConfigDto } from './tenant-types.js'

export enum SecurityModelState
{
    Loading,
    Empty,
    Ready,
    Error,
    NoEnvironment,
    Forbidden,
}

export interface ISecurityModelEnvSource extends ISecurityModelSource
{
    ListEnvironments(): Promise<EnvironmentDto[]>
}

// Presentation-agnostic state for the tenant admin security-model editor. ONE draft backs both
// the role/privilege surface and the field-profile surface, so one Dirty flag and one Save cover
// both and neither section can overwrite the other.
export class SecurityModelViewModel extends Observable
{
    public static readonly EnvironmentsProperty = 'Environments'
    public static readonly SelectedEnvironmentProperty = 'SelectedEnvironment'
    public static readonly RolesProperty = 'Roles'
    public static readonly SelectedRoleIdProperty = 'SelectedRoleId'
    public static readonly PrivilegeRowsProperty = 'PrivilegeRows'
    public static readonly ProfilesProperty = 'Profiles'
    public static readonly SelectedProfileIdProperty = 'SelectedProfileId'
    public static readonly FieldRowsProperty = 'FieldRows'
    public static readonly BusinessUnitRowsProperty = 'BusinessUnitRows'
    public static readonly TeamRowsProperty = 'TeamRows'
    public static readonly MembershipRuleRowsProperty = 'MembershipRuleRows'
    public static readonly MembershipOverrideRowsProperty = 'MembershipOverrideRows'
    public static readonly OwnershipRuleRowsProperty = 'OwnershipRuleRows'
    public static readonly RecordSharingRowsProperty = 'RecordSharingRows'
    public static readonly BusyProperty = 'Busy'
    public static readonly ErrorProperty = 'Error'
    public static readonly StateProperty = 'State'
    public static readonly DirtyProperty = 'Dirty'

    private static readonly NoMessage = ''
    private static readonly NoRoleId = ''

    private environments: readonly string[] = []
    private selectedEnvironment: string | undefined
    private roles: readonly RoleConfigDto[] = []
    private privilegeRows: readonly PrivilegeRow[] = []
    private selectedRoleId: string | undefined
    private profiles: readonly FieldProfileDto[] = []
    private fieldRows: readonly FieldGrantRow[] = []
    private selectedProfileId: string | undefined
    private businessUnitRows: readonly BusinessUnitRow[] = []
    private teamRows: readonly TeamRow[] = []
    private membershipRuleRows: readonly MembershipRuleRow[] = []
    private membershipOverrideRows: readonly MembershipOverrideRow[] = []
    private ownershipRuleRows: readonly OwnershipRuleRow[] = []
    private recordSharingRows: readonly RecordSharingRowData[] = []
    private draft: SecurityModelDraft | undefined
    private busyCount = 0
    private error = SecurityModelViewModel.NoMessage
    private state = SecurityModelState.Loading
    private dirty = false
    private loadToken = 0

    public constructor(private readonly source: ISecurityModelEnvSource)
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

    public get PrivilegeRows(): readonly PrivilegeRow[]
    {
        return this.privilegeRows
    }

    public get Profiles(): readonly FieldProfileDto[]
    {
        return this.profiles
    }

    public get SelectedProfileId(): string | undefined
    {
        return this.selectedProfileId
    }

    public get FieldRows(): readonly FieldGrantRow[]
    {
        return this.fieldRows
    }

    public get BusinessUnitRows(): readonly BusinessUnitRow[]
    {
        return this.businessUnitRows
    }

    public get TeamRows(): readonly TeamRow[]
    {
        return this.teamRows
    }

    public get MembershipRuleRows(): readonly MembershipRuleRow[]
    {
        return this.membershipRuleRows
    }

    public get MembershipOverrideRows(): readonly MembershipOverrideRow[]
    {
        return this.membershipOverrideRows
    }

    public get OwnershipRuleRows(): readonly OwnershipRuleRow[]
    {
        return this.ownershipRuleRows
    }

    public get RecordSharingRows(): readonly RecordSharingRowData[]
    {
        return this.recordSharingRows
    }

    public get Busy(): boolean
    {
        return this.busyCount > 0
    }

    public get Error(): string
    {
        return this.error
    }

    public get State(): SecurityModelState
    {
        return this.state
    }

    public get Dirty(): boolean
    {
        return this.dirty
    }

    public async LoadEnvironments(): Promise<void>
    {
        this.SetState(SecurityModelState.Loading)
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
        this.RaisePropertyChanged(SecurityModelViewModel.EnvironmentsProperty, old, this.environments)
        if (this.environments.length === 0)
        {
            this.loadToken++
            this.SetSelectedEnvironment(undefined)
            this.ResetDraft()
            this.SetState(SecurityModelState.NoEnvironment)
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
        this.SetState(SecurityModelState.Loading)
        try
        {
            const model = await this.source.GetSecurityModel(env)
            if (token !== this.loadToken)
            {
                return
            }
            this.draft = SecurityModelDraft.From(model)
            this.Refresh()
            this.SetError(SecurityModelViewModel.NoMessage)
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

    public AddBusinessUnit(name: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.AddBusinessUnit(name)
        this.Refresh()
    }

    public RenameBusinessUnit(id: string, name: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.RenameBusinessUnit(id, name)
        this.Refresh()
    }

    public SetBusinessUnitParent(id: string, parent?: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.SetBusinessUnitParent(id, parent)
        this.Refresh()
    }

    public RemoveBusinessUnit(id: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.RemoveBusinessUnit(id)
        this.Refresh()
    }

    public AddTeam(name: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.AddTeam(name)
        this.Refresh()
    }

    public RenameTeam(id: string, name: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.RenameTeam(id, name)
        this.Refresh()
    }

    public SetTeamOwningBusinessUnit(id: string, businessUnitId?: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.SetTeamOwningBusinessUnit(id, businessUnitId)
        this.Refresh()
    }

    public RemoveTeam(id: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.RemoveTeam(id)
        this.Refresh()
    }

    public AddMembershipRule(): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.AddMembershipRule()
        this.Refresh()
    }

    public SetMembershipRuleClaim(index: number, claim: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.SetMembershipRuleClaim(index, claim)
        this.Refresh()
    }

    public SetMembershipRuleValue(index: number, value: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.SetMembershipRuleValue(index, value)
        this.Refresh()
    }

    public SetMembershipRuleHomeBusinessUnit(index: number, businessUnitId?: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.SetMembershipRuleHomeBusinessUnit(index, businessUnitId)
        this.Refresh()
    }

    public ToggleMembershipRuleTeam(index: number, teamId: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.ToggleMembershipRuleTeam(index, teamId)
        this.Refresh()
    }

    public RemoveMembershipRule(index: number): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.RemoveMembershipRule(index)
        this.Refresh()
    }

    public AddMembershipOverride(): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.AddMembershipOverride()
        this.Refresh()
    }

    public SetMembershipOverridePrincipal(index: number, principalId: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.SetMembershipOverridePrincipal(index, principalId)
        this.Refresh()
    }

    public SetMembershipOverrideHomeBusinessUnit(index: number, businessUnitId?: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.SetMembershipOverrideHomeBusinessUnit(index, businessUnitId)
        this.Refresh()
    }

    public ToggleMembershipOverrideTeam(index: number, teamId: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.ToggleMembershipOverrideTeam(index, teamId)
        this.Refresh()
    }

    public RemoveMembershipOverride(index: number): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.RemoveMembershipOverride(index)
        this.Refresh()
    }

    public AddOwnershipRule(concept: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.AddOwnershipRule(concept)
        this.Refresh()
    }

    public SetOwningSourceKind(concept: string, kind: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.SetOwningSourceKind(concept, kind)
        this.Refresh()
    }

    public SetOwningSourceValue(concept: string, value: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.SetOwningSourceValue(concept, value)
        this.Refresh()
    }

    public SetOwnerSourceKind(concept: string, kind: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.SetOwnerSourceKind(concept, kind)
        this.Refresh()
    }

    public SetOwnerSourceValue(concept: string, value: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.SetOwnerSourceValue(concept, value)
        this.Refresh()
    }

    public RemoveOwnershipRule(concept: string): void
    {
        if (this.draft === undefined)
        {
            return
        }
        this.draft.Org.RemoveOwnershipRule(concept)
        this.Refresh()
    }

    // Cell edits go straight to the draft through PrivilegeRow / FieldGrantRow; the view calls this afterwards.
    public RefreshDirty(): void
    {
        this.SetDirty(this.draft?.Dirty ?? false)
    }

    // Persists the one draft (roles AND field profiles), then rebases onto what was saved so Dirty clears.
    public async Save(): Promise<void>
    {
        const env = this.selectedEnvironment
        const draft = this.draft
        if (env === undefined || draft === undefined || this.Busy)
        {
            return
        }
        this.SetError(SecurityModelViewModel.NoMessage)
        this.EnterBusy()
        try
        {
            const dto = draft.ToDto()
            await this.source.SetSecurityModel(env, dto)
            if (this.draft === draft)
            {
                this.draft = SecurityModelDraft.From(dto)
                this.draft.SelectedRoleId = draft.SelectedRoleId
                this.draft.SelectedProfileId = draft.SelectedProfileId
                this.Refresh()
            }
        }
        catch (e)
        {
            if (SecurityModelViewModel.IsUnauthorized(e))
            {
                throw e
            }
            if (this.draft !== draft)
            {
                return
            }
            if (SecurityModelViewModel.IsForbidden(e))
            {
                this.FailWith(e)
            }
            else
            {
                this.SetError(SecurityModelViewModel.MessageOf(e))
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

    // Rebuilds Roles/PrivilegeRows/Profiles/FieldRows/both selections/Dirty/State from the draft.
    private Refresh(): void
    {
        const draft = this.draft
        if (draft === undefined)
        {
            return
        }
        const oldRoles = this.roles
        const oldPrivilegeRows = this.privilegeRows
        const oldRole = this.selectedRoleId
        const oldProfiles = this.profiles
        const oldFieldRows = this.fieldRows
        const oldProfile = this.selectedProfileId
        const oldBusinessUnitRows = this.businessUnitRows
        const oldTeamRows = this.teamRows
        const oldMembershipRuleRows = this.membershipRuleRows
        const oldMembershipOverrideRows = this.membershipOverrideRows
        const oldOwnershipRuleRows = this.ownershipRuleRows
        const oldRecordSharingRows = this.recordSharingRows
        this.roles = [...draft.Roles]
        this.privilegeRows = draft.Concepts.map(c => new PrivilegeRow(c, draft))
        this.selectedRoleId = draft.SelectedRoleId
        this.profiles = [...draft.Profiles]
        this.fieldRows = draft.SecuredFields.map(f => new FieldGrantRow(f.concept, f.field, draft))
        this.selectedProfileId = draft.SelectedProfileId
        const org = draft.Org
        this.businessUnitRows = org.BusinessUnits.map(u => new BusinessUnitRow(u, this))
        this.teamRows = org.Teams.map(t => new TeamRow(t, this))
        this.membershipRuleRows = org.Membership.claimsMapping.map((r, i) => new MembershipRuleRow(r, i, this))
        this.membershipOverrideRows = org.Membership.overrides.map((o, i) => new MembershipOverrideRow(o, i, this))
        this.ownershipRuleRows = org.OwnershipRules.map(r => new OwnershipRuleRow(r, this))
        this.recordSharingRows = draft.RecordSharingFor(this.selectedRoleId ?? SecurityModelViewModel.NoRoleId)
        this.RaisePropertyChanged(SecurityModelViewModel.RolesProperty, oldRoles, this.roles)
        this.RaisePropertyChanged(SecurityModelViewModel.SelectedRoleIdProperty, oldRole, this.selectedRoleId)
        this.RaisePropertyChanged(SecurityModelViewModel.PrivilegeRowsProperty, oldPrivilegeRows, this.privilegeRows)
        this.RaisePropertyChanged(SecurityModelViewModel.ProfilesProperty, oldProfiles, this.profiles)
        this.RaisePropertyChanged(SecurityModelViewModel.SelectedProfileIdProperty, oldProfile, this.selectedProfileId)
        this.RaisePropertyChanged(SecurityModelViewModel.FieldRowsProperty, oldFieldRows, this.fieldRows)
        this.RaisePropertyChanged(SecurityModelViewModel.BusinessUnitRowsProperty, oldBusinessUnitRows, this.businessUnitRows)
        this.RaisePropertyChanged(SecurityModelViewModel.TeamRowsProperty, oldTeamRows, this.teamRows)
        this.RaisePropertyChanged(SecurityModelViewModel.MembershipRuleRowsProperty, oldMembershipRuleRows, this.membershipRuleRows)
        this.RaisePropertyChanged(SecurityModelViewModel.MembershipOverrideRowsProperty, oldMembershipOverrideRows, this.membershipOverrideRows)
        this.RaisePropertyChanged(SecurityModelViewModel.OwnershipRuleRowsProperty, oldOwnershipRuleRows, this.ownershipRuleRows)
        this.RaisePropertyChanged(SecurityModelViewModel.RecordSharingRowsProperty, oldRecordSharingRows, this.recordSharingRows)
        this.SetDirty(draft.Dirty)
        const empty = this.roles.length === 0 && this.profiles.length === 0
        this.SetState(empty ? SecurityModelState.Empty : SecurityModelState.Ready)
    }

    private ResetDraft(): void
    {
        this.draft = undefined
        const oldRoles = this.roles
        const oldPrivilegeRows = this.privilegeRows
        const oldRole = this.selectedRoleId
        const oldProfiles = this.profiles
        const oldFieldRows = this.fieldRows
        const oldProfile = this.selectedProfileId
        const oldBusinessUnitRows = this.businessUnitRows
        const oldTeamRows = this.teamRows
        const oldMembershipRuleRows = this.membershipRuleRows
        const oldMembershipOverrideRows = this.membershipOverrideRows
        const oldOwnershipRuleRows = this.ownershipRuleRows
        const oldRecordSharingRows = this.recordSharingRows
        this.roles = []
        this.privilegeRows = []
        this.selectedRoleId = undefined
        this.profiles = []
        this.fieldRows = []
        this.selectedProfileId = undefined
        this.businessUnitRows = []
        this.teamRows = []
        this.membershipRuleRows = []
        this.membershipOverrideRows = []
        this.ownershipRuleRows = []
        this.recordSharingRows = []
        this.RaisePropertyChanged(SecurityModelViewModel.RolesProperty, oldRoles, this.roles)
        this.RaisePropertyChanged(SecurityModelViewModel.SelectedRoleIdProperty, oldRole, undefined)
        this.RaisePropertyChanged(SecurityModelViewModel.PrivilegeRowsProperty, oldPrivilegeRows, this.privilegeRows)
        this.RaisePropertyChanged(SecurityModelViewModel.ProfilesProperty, oldProfiles, this.profiles)
        this.RaisePropertyChanged(SecurityModelViewModel.SelectedProfileIdProperty, oldProfile, undefined)
        this.RaisePropertyChanged(SecurityModelViewModel.FieldRowsProperty, oldFieldRows, this.fieldRows)
        this.RaisePropertyChanged(SecurityModelViewModel.BusinessUnitRowsProperty, oldBusinessUnitRows, this.businessUnitRows)
        this.RaisePropertyChanged(SecurityModelViewModel.TeamRowsProperty, oldTeamRows, this.teamRows)
        this.RaisePropertyChanged(SecurityModelViewModel.MembershipRuleRowsProperty, oldMembershipRuleRows, this.membershipRuleRows)
        this.RaisePropertyChanged(SecurityModelViewModel.MembershipOverrideRowsProperty, oldMembershipOverrideRows, this.membershipOverrideRows)
        this.RaisePropertyChanged(SecurityModelViewModel.OwnershipRuleRowsProperty, oldOwnershipRuleRows, this.ownershipRuleRows)
        this.RaisePropertyChanged(SecurityModelViewModel.RecordSharingRowsProperty, oldRecordSharingRows, this.recordSharingRows)
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
        if (SecurityModelViewModel.IsUnauthorized(e))
        {
            throw e
        }
        if (SecurityModelViewModel.IsForbidden(e))
        {
            this.SetError(SecurityModelViewModel.NoMessage)
            this.SetState(SecurityModelState.Forbidden)
            return
        }
        this.SetError(SecurityModelViewModel.MessageOf(e))
        this.SetState(SecurityModelState.Error)
    }

    private SetSelectedEnvironment(value: string | undefined): void
    {
        const old = this.selectedEnvironment
        this.selectedEnvironment = value
        this.RaisePropertyChanged(SecurityModelViewModel.SelectedEnvironmentProperty, old, value)
    }

    // Counter, not a flag: overlapping loads and saves each hold Busy until they finish.
    private EnterBusy(): void
    {
        this.busyCount++
        if (this.busyCount === 1)
        {
            this.RaisePropertyChanged(SecurityModelViewModel.BusyProperty, false, true)
        }
    }

    private ExitBusy(): void
    {
        this.busyCount--
        if (this.busyCount === 0)
        {
            this.RaisePropertyChanged(SecurityModelViewModel.BusyProperty, true, false)
        }
    }

    private SetDirty(value: boolean): void
    {
        const old = this.dirty
        this.dirty = value
        if (old !== value)
        {
            this.RaisePropertyChanged(SecurityModelViewModel.DirtyProperty, old, value)
        }
    }

    private SetError(value: string): void
    {
        const old = this.error
        this.error = value
        this.RaisePropertyChanged(SecurityModelViewModel.ErrorProperty, old, value)
    }

    private SetState(value: SecurityModelState): void
    {
        const old = this.state
        this.state = value
        this.RaisePropertyChanged(SecurityModelViewModel.StateProperty, old, value)
    }
}
