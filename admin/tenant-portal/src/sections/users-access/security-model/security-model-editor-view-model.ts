import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { TenantApiError } from '../../../tenant-api-client.js'
import { SecurityRoleKind, type SecurityProfileDto, type SecurityRoleDto } from '../../../tenant-types.js'
import { AdminCapability } from '../../../shell/admin-capability.js'
import { PendingWork, type IHoldsPendingWork } from '../../../shell/holds-pending-work.js'
import type { TenantSessionService } from '../../../shell/tenant-session-service.js'
import { EnvironmentScopedPageViewModel } from '../environment-scoped-page-view-model.js'
import type { UsersAccessSectionService } from '../users-access-section-service.js'
import { AssignmentEditorViewModel, AssignmentSide } from './assignment-editor-view-model.js'
import { SecurityChangesViewModel } from './security-changes-view-model.js'
import { SecurityModelDraft } from './security-model-draft.js'
import { SecurityModelPart, type ISecurityModelEditHost } from './security-model-edit-host.js'
import { BaseRole, LevelCycle } from './security-model-enums.js'
import { BusinessUnitRowViewModel, TeamRowViewModel, UserPlacementRowViewModel } from './security-model-org-rows.js'
import { FieldGrantRowViewModel, LegendEntryViewModel, PrivilegeRowViewModel, ProfileItemViewModel, RoleItemViewModel } from './security-model-role-rows.js'
import { SecurityModelText } from './security-model-text.js'
import { TabSelection } from './tab-selection.js'
import { TeamMembersState } from './team-members-state.js'
import { UnitTree } from './unit-tree.js'

// The editor's modes.
export enum SecurityModelMode
{
    Roles,
    Profiles,
    Organization,
    Changes,
}

// The per-profile tabs (Profiles mode).
export enum ProfileTab
{
    Fields,
    People,
}

// The per-role tabs (Roles mode).
export enum RoleTab
{
    Privileges,
    People,
}

// The organization tabs (Organization mode).
export enum OrgTab
{
    BusinessUnits,
    People,
    Teams,
}

// The typed-in values the Add actions read.
enum NewInput
{
    BusinessUnit,
    User,
    Team,
}

// The Roles & permissions tab: the security-setting editor for the selected
// environment. ONE draft (the setting over the environment's catalog) backs
// every surface (the catalog's roles and their privilege overrides, field
// profiles, who holds what, the organization), so one dirty flag and
// one save bar (Save / Discard) cover the whole model. Rows are view-models
// editing the draft in place through Apply; a structural change (add /
// remove) rebuilds the row collections (new instances, raised), while a text
// edit never replaces the collection holding the box being typed in. Every
// edit is refused while a load or save is in flight or without the Manage
// users & access permission (the controls stay visible, disabled). Unsaved
// changes are pending work: the page asks before switching environment, and
// a cross-section navigation does not discard them.
export class SecurityModelEditorViewModel extends EnvironmentScopedPageViewModel implements IHoldsPendingWork, ISecurityModelEditHost
{
    private static readonly RolesLabel = 'Roles'
    private static readonly ProfilesLabel = 'Field profiles'
    private static readonly OrganizationLabel = 'Organization'
    private static readonly ChangesLabel = 'Changes'
    private static readonly FieldAccessLabel = 'Field access'
    private static readonly PrivilegesLabel = 'What they can do'
    private static readonly PeopleLabel = 'People'
    private static readonly BusinessUnitsLabel = 'Business units'
    private static readonly TeamsLabel = 'Teams'
    private static readonly UnsavedText = 'Unsaved changes'
    private static readonly NoChangesText = 'No unsaved changes'
    private static readonly Empty = ''

    private static readonly SelectedModeProperty = 'SelectedMode'
    private static readonly IsRolesModeProperty = 'IsRolesMode'
    private static readonly IsOrganizationModeProperty = 'IsOrganizationMode'
    private static readonly IsProfilesModeProperty = 'IsProfilesMode'
    private static readonly IsChangesModeProperty = 'IsChangesMode'
    private static readonly SelectedProfileTabProperty = 'SelectedProfileTab'
    private static readonly IsFieldsTabProperty = 'IsFieldsTab'
    private static readonly IsProfilePeopleTabProperty = 'IsProfilePeopleTab'
    private static readonly SelectedRoleTabProperty = 'SelectedRoleTab'
    private static readonly IsPrivilegesTabProperty = 'IsPrivilegesTab'
    private static readonly IsSystemAdministratorProperty = 'IsSystemAdministrator'
    private static readonly ShowsMatrixProperty = 'ShowsMatrix'
    private static readonly IsPeopleTabProperty = 'IsPeopleTab'
    private static readonly SelectedOrgTabProperty = 'SelectedOrgTab'
    private static readonly IsBusinessUnitsTabProperty = 'IsBusinessUnitsTab'
    private static readonly IsTeamsTabProperty = 'IsTeamsTab'
    private static readonly IsOrgPeopleTabProperty = 'IsOrgPeopleTab'
    private static readonly RolesProperty = 'Roles'
    private static readonly HasRolesProperty = 'HasRoles'
    private static readonly HasNoRolesProperty = 'HasNoRoles'
    private static readonly SelectedRoleProperty = 'SelectedRole'
    private static readonly HasSelectedRoleProperty = 'HasSelectedRole'
    private static readonly HasNoSelectedRoleProperty = 'HasNoSelectedRole'
    private static readonly SelectedRoleNameProperty = 'SelectedRoleName'
    private static readonly PrivilegeRowsProperty = 'PrivilegeRows'
    private static readonly ProfilesProperty = 'Profiles'
    private static readonly HasProfilesProperty = 'HasProfiles'
    private static readonly HasNoProfilesProperty = 'HasNoProfiles'
    private static readonly SelectedProfileProperty = 'SelectedProfile'
    private static readonly HasSelectedProfileProperty = 'HasSelectedProfile'
    private static readonly FieldRowsProperty = 'FieldRows'
    private static readonly HasNoFieldRowsProperty = 'HasNoFieldRows'
    private static readonly BusinessUnitRowsProperty = 'BusinessUnitRows'
    private static readonly HasNoBusinessUnitsProperty = 'HasNoBusinessUnits'
    private static readonly UserRowsProperty = 'UserRows'
    private static readonly HasNoUsersProperty = 'HasNoUsers'
    private static readonly TeamRowsProperty = 'TeamRows'
    private static readonly HasNoTeamsProperty = 'HasNoTeams'
    private static readonly IsDirtyProperty = 'IsDirty'
    private static readonly HasPendingWorkProperty = 'HasPendingWork'
    private static readonly SaveStateTextProperty = 'SaveStateText'
    private static readonly IsBusyProperty = 'IsBusy'
    private static readonly InputProperties: ReadonlyMap<NewInput, string> = new Map<NewInput, string>([
        [NewInput.BusinessUnit, 'NewBusinessUnitName'],
        [NewInput.User, 'NewUserPrincipalId'],
        [NewInput.Team, 'NewTeamName'],
    ])

    private static readonly Parts: readonly SecurityModelPart[] = [
        SecurityModelPart.Roles, SecurityModelPart.Privileges, SecurityModelPart.RoleAssignment,
        SecurityModelPart.Profiles, SecurityModelPart.FieldGrants, SecurityModelPart.ProfileAssignment,
        SecurityModelPart.BusinessUnits, SecurityModelPart.Users, SecurityModelPart.Teams,
    ]

    private readonly mode = new TabSelection<SecurityModelMode>([
        [SecurityModelMode.Roles, SecurityModelEditorViewModel.RolesLabel],
        [SecurityModelMode.Profiles, SecurityModelEditorViewModel.ProfilesLabel],
        [SecurityModelMode.Organization, SecurityModelEditorViewModel.OrganizationLabel],
        [SecurityModelMode.Changes, SecurityModelEditorViewModel.ChangesLabel],
    ])
    private readonly profileTab = new TabSelection<ProfileTab>([
        [ProfileTab.Fields, SecurityModelEditorViewModel.FieldAccessLabel],
        [ProfileTab.People, SecurityModelEditorViewModel.PeopleLabel],
    ])
    private readonly roleTab = new TabSelection<RoleTab>([
        [RoleTab.Privileges, SecurityModelEditorViewModel.PrivilegesLabel],
        [RoleTab.People, SecurityModelEditorViewModel.PeopleLabel],
    ])
    private readonly orgTab = new TabSelection<OrgTab>([
        [OrgTab.BusinessUnits, SecurityModelEditorViewModel.BusinessUnitsLabel],
        [OrgTab.People, SecurityModelEditorViewModel.PeopleLabel],
        [OrgTab.Teams, SecurityModelEditorViewModel.TeamsLabel],
    ])

    private draft: SecurityModelDraft | undefined
    // The selected catalog role / profile (by name); kept across a save.
    private selectedRoleId: string | undefined
    private selectedProfileId: string | undefined
    private dirty = false
    private busy = 0
    private discarding = false
    private pendingFailure: unknown
    private readonly inputs = new Map<NewInput, string>()
    private readonly roleItems = new Map<string, RoleItemViewModel>()
    private readonly profileItems = new Map<string, ProfileItemViewModel>()
    private readonly unitTree = new UnitTree()
    // The server's member rows per saved team and the team rows' typed input; reset with the draft.
    private readonly teamMembers: TeamMembersState
    private roles = new ObservableCollection<RoleItemViewModel>()
    private privilegeRows = new ObservableCollection<PrivilegeRowViewModel>()
    private profiles = new ObservableCollection<ProfileItemViewModel>()
    private fieldRows = new ObservableCollection<FieldGrantRowViewModel>()
    private businessUnitRows = new ObservableCollection<BusinessUnitRowViewModel>()
    private userRows = new ObservableCollection<UserPlacementRowViewModel>()
    private teamRows = new ObservableCollection<TeamRowViewModel>()
    private readonly legend = new ObservableCollection<LegendEntryViewModel>()
    private readonly roleAssignment: AssignmentEditorViewModel
    private readonly profileAssignment: AssignmentEditorViewModel
    private readonly securityChanges: SecurityChangesViewModel
    private readonly saveCommand: RelayCommand
    private readonly discardCommand: RelayCommand
    private readonly addBusinessUnitCommand: RelayCommand
    private readonly placeUserCommand: RelayCommand
    private readonly addTeamCommand: RelayCommand

    public constructor(session: TenantSessionService, protected readonly section: UsersAccessSectionService)
    {
        super(session)
        this.roleAssignment = new AssignmentEditorViewModel(this, AssignmentSide.Role)
        this.profileAssignment = new AssignmentEditorViewModel(this, AssignmentSide.Profile)
        this.securityChanges = new SecurityChangesViewModel(session, this)
        this.teamMembers = new TeamMembersState(session, this)
        for (const level of LevelCycle)
        {
            this.legend.Add(new LegendEntryViewModel(level))
        }
        const dirtyAndIdle = (): boolean => this.dirty && this.busy === 0
        this.saveCommand = this.MutatingCommand(AdminCapability.Access, () => this.Save(), dirtyAndIdle)
        this.discardCommand = this.MutatingCommand(AdminCapability.Access, () => this.Discard(), dirtyAndIdle)
        this.addBusinessUnitCommand = this.EditCommand(() => this.AddBusinessUnit())
        // A user needs a unit to sit in: disabled until the root exists.
        this.placeUserCommand = new RelayCommand(() => this.PlaceUser(), () => this.CanEdit && this.draft?.Org.RootBusinessUnitId !== undefined)
        // A team needs a unit to sit in: disabled until the root exists.
        this.addTeamCommand = new RelayCommand(() => this.AddTeam(), () => this.CanEdit && this.draft?.Org.RootBusinessUnitId !== undefined)
        PendingWork.Register(this)
    }

    protected override get PageCapability(): AdminCapability | undefined
    {
        return AdminCapability.Access
    }

    // ---- Editing state -------------------------------------------------

    // Whether the operator may edit the model (the Manage users & access
    // permission). Controls bind IsEnabled to it: denied, not hidden.
    public get CanEdit(): boolean
    {
        return this.CanMutate
    }

    // A load or save is in flight; every edit is refused meanwhile.
    public get IsBusy(): boolean
    {
        return this.busy > 0
    }

    public get IsDirty(): boolean
    {
        return this.dirty
    }

    public get HasPendingWork(): boolean
    {
        return this.dirty
    }

    public get SaveStateText(): string
    {
        return this.dirty ? SecurityModelEditorViewModel.UnsavedText : SecurityModelEditorViewModel.NoChangesText
    }

    // The draft being edited (undefined before the model loads); tests read it.
    public get Draft(): SecurityModelDraft | undefined
    {
        return this.draft
    }

    public get SaveCommand(): RelayCommand
    {
        return this.saveCommand
    }

    public get DiscardCommand(): RelayCommand
    {
        return this.discardCommand
    }

    // ---- Modes and tabs ------------------------------------------------

    public get ModeLabels(): ObservableCollection<string>
    {
        return this.mode.Labels
    }

    public get SelectedMode(): string
    {
        return this.mode.Label
    }

    public set SelectedMode(label: string)
    {
        if (this.mode.Select(label))
        {
            const P = SecurityModelEditorViewModel
            this.Raise(P.SelectedModeProperty, P.IsRolesModeProperty, P.IsProfilesModeProperty, P.IsOrganizationModeProperty, P.IsChangesModeProperty)
            if (this.IsChangesMode)
            {
                void this.securityChanges.Refresh()
            }
        }
    }

    public get IsProfilesMode(): boolean
    {
        return this.mode.Is(SecurityModelMode.Profiles)
    }

    // The security change log (Changes mode); reloaded each time the mode is opened.
    public get SecurityChanges(): SecurityChangesViewModel
    {
        return this.securityChanges
    }

    public get IsChangesMode(): boolean
    {
        return this.mode.Is(SecurityModelMode.Changes)
    }

    public get ProfileTabLabels(): ObservableCollection<string>
    {
        return this.profileTab.Labels
    }

    public get SelectedProfileTab(): string
    {
        return this.profileTab.Label
    }

    public set SelectedProfileTab(label: string)
    {
        if (this.profileTab.Select(label))
        {
            const P = SecurityModelEditorViewModel
            this.Raise(P.SelectedProfileTabProperty, P.IsFieldsTabProperty, P.IsProfilePeopleTabProperty)
        }
    }

    public get IsFieldsTab(): boolean
    {
        return this.profileTab.Is(ProfileTab.Fields)
    }

    public get IsProfilePeopleTab(): boolean
    {
        return this.profileTab.Is(ProfileTab.People)
    }

    public get IsRolesMode(): boolean
    {
        return this.mode.Is(SecurityModelMode.Roles)
    }

    public get IsOrganizationMode(): boolean
    {
        return this.mode.Is(SecurityModelMode.Organization)
    }

    public get RoleTabLabels(): ObservableCollection<string>
    {
        return this.roleTab.Labels
    }

    public get SelectedRoleTab(): string
    {
        return this.roleTab.Label
    }

    public set SelectedRoleTab(label: string)
    {
        if (this.roleTab.Select(label))
        {
            const P = SecurityModelEditorViewModel
            this.Raise(P.SelectedRoleTabProperty, P.IsPrivilegesTabProperty, P.IsPeopleTabProperty)
        }
    }

    public get IsPrivilegesTab(): boolean
    {
        return this.roleTab.Is(RoleTab.Privileges)
    }

    public get IsPeopleTab(): boolean
    {
        return this.roleTab.Is(RoleTab.People)
    }

    public get OrgTabLabels(): ObservableCollection<string>
    {
        return this.orgTab.Labels
    }

    public get SelectedOrgTab(): string
    {
        return this.orgTab.Label
    }

    public set SelectedOrgTab(label: string)
    {
        if (this.orgTab.Select(label))
        {
            const P = SecurityModelEditorViewModel
            this.Raise(P.SelectedOrgTabProperty, P.IsBusinessUnitsTabProperty, P.IsOrgPeopleTabProperty, P.IsTeamsTabProperty)
        }
    }

    public get IsBusinessUnitsTab(): boolean
    {
        return this.orgTab.Is(OrgTab.BusinessUnits)
    }

    public get IsOrgPeopleTab(): boolean
    {
        return this.orgTab.Is(OrgTab.People)
    }

    public get IsTeamsTab(): boolean
    {
        return this.orgTab.Is(OrgTab.Teams)
    }

    // ---- Roles ---------------------------------------------------------

    public get Roles(): ObservableCollection<RoleItemViewModel>
    {
        return this.roles
    }

    public get HasRoles(): boolean
    {
        return this.roles.Count > 0
    }

    // Whether the catalog lists no roles (none loaded yet).
    public get HasNoRoles(): boolean
    {
        return !this.HasRoles
    }

    public get SelectedRole(): RoleItemViewModel | undefined
    {
        const id = this.selectedRoleId
        return id === undefined ? undefined : this.roleItems.get(id)
    }

    // Selecting a role is not an edit (it needs no permission) but, like an
    // edit, it waits for an in-flight load or save.
    public set SelectedRole(item: RoleItemViewModel | undefined)
    {
        const draft = this.draft
        if (!(item instanceof RoleItemViewModel) || draft === undefined || item.Id === this.selectedRoleId)
        {
            return
        }
        if (this.busy === 0)
        {
            this.selectedRoleId = item.Id
            this.RebuildRoleScope()
        }
        this.Raise(SecurityModelEditorViewModel.SelectedRoleProperty)
    }

    public get HasSelectedRole(): boolean
    {
        return this.SelectedRole !== undefined
    }

    public get HasNoSelectedRole(): boolean
    {
        return !this.HasSelectedRole
    }

    public get SelectedRoleName(): string
    {
        return this.SelectedRole?.Name ?? SecurityModelEditorViewModel.Empty
    }

    // Whether the selected role is SystemAdministrator: the matrix is replaced by
    // SystemAdministratorText (the role cannot be overridden).
    public get IsSystemAdministrator(): boolean
    {
        return this.selectedRoleId === BaseRole.SystemAdministrator
    }

    // Whether the matrix is shown: a role other than SystemAdministrator is selected.
    public get ShowsMatrix(): boolean
    {
        return this.HasSelectedRole && !this.IsSystemAdministrator
    }

    public get SystemAdministratorText(): string
    {
        return SecurityModelText.SystemAdministratorText
    }

    // The privilege matrix: one row per catalog concept for the selected role.
    public get PrivilegeRows(): ObservableCollection<PrivilegeRowViewModel>
    {
        return this.privilegeRows
    }

    public get Legend(): ObservableCollection<LegendEntryViewModel>
    {
        return this.legend
    }

    public get RoleAssignment(): AssignmentEditorViewModel
    {
        return this.roleAssignment
    }

    // ---- Field profiles ------------------------------------------------

    public get Profiles(): ObservableCollection<ProfileItemViewModel>
    {
        return this.profiles
    }

    public get HasProfiles(): boolean
    {
        return this.profiles.Count > 0
    }

    // Whether the catalog lists no field profiles (none loaded yet).
    public get HasNoProfiles(): boolean
    {
        return !this.HasProfiles
    }

    public get SelectedProfile(): ProfileItemViewModel | undefined
    {
        const id = this.selectedProfileId
        return id === undefined ? undefined : this.profileItems.get(id)
    }

    public set SelectedProfile(item: ProfileItemViewModel | undefined)
    {
        const draft = this.draft
        if (!(item instanceof ProfileItemViewModel) || draft === undefined || item.Id === this.selectedProfileId)
        {
            return
        }
        if (this.busy === 0)
        {
            this.selectedProfileId = item.Id
            this.RebuildProfileScope()
        }
        this.Raise(SecurityModelEditorViewModel.SelectedProfileProperty)
    }

    public get HasSelectedProfile(): boolean
    {
        return this.SelectedProfile !== undefined
    }

    // The catalog's secured-field grid for the selected profile.
    public get FieldRows(): ObservableCollection<FieldGrantRowViewModel>
    {
        return this.fieldRows
    }

    public get HasNoFieldRows(): boolean
    {
        return this.fieldRows.Count === 0
    }

    public get ProfileAssignment(): AssignmentEditorViewModel
    {
        return this.profileAssignment
    }

    // ---- Organization --------------------------------------------------

    public get BusinessUnitRows(): ObservableCollection<BusinessUnitRowViewModel>
    {
        return this.businessUnitRows
    }

    public get HasNoBusinessUnits(): boolean
    {
        return this.businessUnitRows.Count === 0
    }

    public get NewBusinessUnitName(): string
    {
        return this.Input(NewInput.BusinessUnit)
    }

    public set NewBusinessUnitName(value: string)
    {
        this.SetInput(NewInput.BusinessUnit, value)
    }

    public get AddBusinessUnitCommand(): RelayCommand
    {
        return this.addBusinessUnitCommand
    }

    public get UserRows(): ObservableCollection<UserPlacementRowViewModel>
    {
        return this.userRows
    }

    public get HasNoUsers(): boolean
    {
        return this.userRows.Count === 0
    }

    public get NewUserPrincipalId(): string
    {
        return this.Input(NewInput.User)
    }

    public set NewUserPrincipalId(value: string)
    {
        this.SetInput(NewInput.User, value)
    }

    public get PlaceUserCommand(): RelayCommand
    {
        return this.placeUserCommand
    }

    public get TeamRows(): ObservableCollection<TeamRowViewModel>
    {
        return this.teamRows
    }

    public get HasNoTeams(): boolean
    {
        return this.teamRows.Count === 0
    }

    public get NewTeamName(): string
    {
        return this.Input(NewInput.Team)
    }

    public set NewTeamName(value: string)
    {
        this.SetInput(NewInput.Team, value)
    }

    public get AddTeamCommand(): RelayCommand
    {
        return this.addTeamCommand
    }

    // ---- ISecurityModelEditHost ----------------------------------------

    public Apply(change: (draft: SecurityModelDraft) => void): boolean
    {
        const draft = this.draft
        if (draft === undefined || this.busy > 0 || !this.CanEdit)
        {
            return false
        }
        change(draft)
        this.SyncDirty()
        return true
    }

    public Rebuild(except?: SecurityModelPart): void
    {
        this.unitTree.SyncOptions(this.draft?.Org.BusinessUnits ?? [])
        for (const part of SecurityModelEditorViewModel.Parts)
        {
            if (part !== except)
            {
                this.RebuildPart(part)
            }
        }
        if (except === SecurityModelPart.BusinessUnits)
        {
            this.SyncUnitTree(true)
        }
        this.SyncDirty()
    }

    public RebuildPart(part: SecurityModelPart): void
    {
        switch (part)
        {
            case SecurityModelPart.Roles:
                this.RebuildRoles()
                break
            case SecurityModelPart.Privileges:
                this.RebuildPrivileges()
                break
            case SecurityModelPart.RoleAssignment:
                this.roleAssignment.Rebuild(this.draft, this.selectedRoleId)
                break
            case SecurityModelPart.Profiles:
                this.RebuildProfiles()
                break
            case SecurityModelPart.FieldGrants:
                this.RebuildFieldGrants()
                break
            case SecurityModelPart.ProfileAssignment:
                this.profileAssignment.Rebuild(this.draft, this.selectedProfileId)
                break
            case SecurityModelPart.BusinessUnits:
                this.RebuildBusinessUnits()
                break
            case SecurityModelPart.Users:
                this.RebuildUsers()
                break
            case SecurityModelPart.Teams:
                this.RebuildTeams()
                break
        }
    }

    public RefreshUnitTree(): void
    {
        this.SyncUnitTree(false)
    }

    // ---- Loading and saving --------------------------------------------

    protected override OnEnvironmentChanged(): void
    {
        this.SetDraft(undefined)
        this.securityChanges.Invalidate()
    }

    // The setting and the catalog load together (a null setting from the
    // server: an empty one) and the draft is built from both, so the
    // organization stays editable before anything is assigned. A background
    // reload (a live update) keeps unsaved changes; Discard reloads regardless.
    protected override async LoadFor(environment: string): Promise<boolean>
    {
        const failure = this.pendingFailure
        if (failure !== undefined)
        {
            this.pendingFailure = undefined
            throw failure
        }
        if (this.dirty && !this.discarding)
        {
            // The kept draft is not reloaded, but the change log still follows the reload.
            if (this.IsChangesMode)
            {
                void this.securityChanges.Refresh()
            }
            return true
        }
        const generation = this.LoadGeneration
        this.EnterBusy()
        try
        {
            const client = this.Session.Client
            const [model, catalog] = await Promise.all([client.GetSecurityModel(environment), client.GetSecurityCatalog(environment)])
            if (generation === this.LoadGeneration)
            {
                this.SetDraft(new SecurityModelDraft(model ?? SecurityModelDraft.EmptyModel(), catalog))
                if (this.IsChangesMode)
                {
                    void this.securityChanges.Refresh()
                }
            }
            return true
        }
        finally
        {
            this.ExitBusy()
        }
    }

    // PUTs the whole setting, then rebases the draft onto what was saved
    // (dirty clears, both selections kept). A 403 shows the Denied state.
    private async Save(): Promise<void>
    {
        const environment = this.Environment
        const draft = this.draft
        if (environment === undefined || draft === undefined || this.busy > 0)
        {
            return
        }
        const dto = draft.ToDto()
        let forbidden: unknown
        this.EnterBusy()
        try
        {
            await this.Session.Client.SetSecurityModel(environment, dto)
        }
        catch (e)
        {
            if (!(e instanceof TenantApiError && e.Status === TenantApiError.ForbiddenStatus))
            {
                throw e
            }
            forbidden = e
        }
        finally
        {
            this.ExitBusy()
        }
        if (forbidden !== undefined)
        {
            // Reported through the page's state machine: the reload rethrows it.
            this.pendingFailure = forbidden
            // Drop the draft too: the reload would rethrow the failure even
            // with it kept, but a Denied page must not go on reporting pending
            // work (blocking environment switches and navigation) for edits
            // the server will never accept.
            this.SetDraft(undefined)
            await this.Refresh()
            return
        }
        if (this.draft === draft)
        {
            this.SetDraft(new SecurityModelDraft(dto, draft.Catalog))
        }
    }

    // Drops the unsaved changes by reloading the model from the server.
    private async Discard(): Promise<void>
    {
        this.discarding = true
        try
        {
            await this.Refresh()
        }
        finally
        {
            this.discarding = false
        }
    }

    // ---- Add / delete --------------------------------------------------

    private AddBusinessUnit(): void
    {
        const name = this.Input(NewInput.BusinessUnit).trim()
        if (name.length > 0 && this.Apply(d => { d.Org.AddBusinessUnit(name) }))
        {
            this.SetInput(NewInput.BusinessUnit, SecurityModelEditorViewModel.Empty)
            this.Rebuild()
        }
    }

    // A new placement starts in the root unit. An already-placed id is ignored:
    // the row's picker is the only way to move someone.
    private PlaceUser(): void
    {
        const id = this.Input(NewInput.User).trim()
        const root = this.draft?.Org.RootBusinessUnitId
        if (id.length === 0 || root === undefined)
        {
            return
        }
        if (this.IsPlaced(id))
        {
            this.SetInput(NewInput.User, SecurityModelEditorViewModel.Empty)
        }
        else if (this.Apply(d => { d.Org.PlaceUser(id, root) }))
        {
            this.SetInput(NewInput.User, SecurityModelEditorViewModel.Empty)
            this.Rebuild()
        }
    }

    private IsPlaced(id: string): boolean
    {
        return this.draft?.Org.Users.some(u => u.principalId === id) ?? false
    }

    private AddTeam(): void
    {
        const name = this.Input(NewInput.Team).trim()
        if (name.length > 0 && this.draft?.Org.RootBusinessUnitId !== undefined && this.Apply(d => { d.Org.AddTeam(name) }))
        {
            this.SetInput(NewInput.Team, SecurityModelEditorViewModel.Empty)
            this.Rebuild()
        }
    }

    // ---- Rebuilding ----------------------------------------------------

    // A new draft keeps the selected role / profile while the catalog still
    // lists it, else selects the first.
    private SetDraft(draft: SecurityModelDraft | undefined): void
    {
        this.draft = draft
        this.teamMembers.Reset(draft?.ToDto())
        const roles = SecurityModelEditorViewModel.OrderedRoles(draft?.Catalog.roles ?? [])
        const profiles = SecurityModelEditorViewModel.OrderedProfiles(draft?.Catalog.profiles ?? [])
        this.selectedRoleId = roles.some(r => r.name === this.selectedRoleId) ? this.selectedRoleId : roles[0]?.name
        this.selectedProfileId = profiles.some(p => p.name === this.selectedProfileId) ? this.selectedProfileId : profiles[0]?.name
        this.Rebuild()
    }

    // The selected role changed: its matrix and holders follow.
    private RebuildRoleScope(): void
    {
        this.RebuildPrivileges()
        this.RebuildPart(SecurityModelPart.RoleAssignment)
        const P = SecurityModelEditorViewModel
        this.Raise(P.HasSelectedRoleProperty, P.HasNoSelectedRoleProperty, P.SelectedRoleNameProperty, P.IsSystemAdministratorProperty, P.ShowsMatrixProperty)
    }

    private RebuildProfileScope(): void
    {
        this.RebuildFieldGrants()
        this.RebuildPart(SecurityModelPart.ProfileAssignment)
        const P = SecurityModelEditorViewModel
        this.Raise(P.HasSelectedProfileProperty)
    }

    // Ordinal (code-unit) comparison: the catalog order is the same in every locale.
    private static Ordinal(a: string, b: string): number
    {
        return a < b ? -1 : a > b ? 1 : 0
    }

    // Base roles first in BaseRole order, then package roles by name.
    private static OrderedRoles(roles: readonly SecurityRoleDto[]): SecurityRoleDto[]
    {
        const base = Object.values(BaseRole) as string[]
        const rank = (r: SecurityRoleDto): number => r.kind === SecurityRoleKind.Base && base.includes(r.name) ? base.indexOf(r.name) : base.length
        return [...roles].sort((a, b) => rank(a) - rank(b) || SecurityModelEditorViewModel.Ordinal(a.name, b.name))
    }

    // Profiles by name (ordinal), as the package roles are.
    private static OrderedProfiles(profiles: readonly SecurityProfileDto[]): SecurityProfileDto[]
    {
        return [...profiles].sort((a, b) => SecurityModelEditorViewModel.Ordinal(a.name, b.name))
    }

    private RebuildRoles(): void
    {
        const draft = this.draft
        const roles = SecurityModelEditorViewModel.OrderedRoles(draft?.Catalog.roles ?? [])
        const live = new Set<string>(roles.map(r => r.name))
        for (const id of [...this.roleItems.keys()])
        {
            if (!live.has(id))
            {
                this.roleItems.delete(id)
            }
        }
        this.roles = new ObservableCollection<RoleItemViewModel>()
        for (const role of roles)
        {
            let item = this.roleItems.get(role.name)
            if (item === undefined)
            {
                item = new RoleItemViewModel(role.name)
                this.roleItems.set(role.name, item)
            }
            item.Update(role, draft?.Assignments.Holders(role.name).PrincipalIds.length ?? 0)
            this.roles.Add(item)
        }
        const P = SecurityModelEditorViewModel
        this.Raise(P.RolesProperty, P.HasRolesProperty, P.HasNoRolesProperty, P.SelectedRoleProperty,
            P.HasSelectedRoleProperty, P.HasNoSelectedRoleProperty, P.SelectedRoleNameProperty, P.IsSystemAdministratorProperty, P.ShowsMatrixProperty)
    }

    private RebuildPrivileges(): void
    {
        const draft = this.draft
        this.privilegeRows = new ObservableCollection<PrivilegeRowViewModel>()
        const role = this.selectedRoleId
        if (draft !== undefined && role !== undefined)
        {
            for (const concept of draft.Catalog.concepts.map(c => c.name).sort(SecurityModelEditorViewModel.Ordinal))
            {
                this.privilegeRows.Add(new PrivilegeRowViewModel(this, draft, role, concept))
            }
        }
        this.Raise(SecurityModelEditorViewModel.PrivilegeRowsProperty)
    }

    private RebuildProfiles(): void
    {
        const profiles = SecurityModelEditorViewModel.OrderedProfiles(this.draft?.Catalog.profiles ?? [])
        const live = new Set<string>(profiles.map(p => p.name))
        for (const id of [...this.profileItems.keys()])
        {
            if (!live.has(id))
            {
                this.profileItems.delete(id)
            }
        }
        this.profiles = new ObservableCollection<ProfileItemViewModel>()
        for (const profile of profiles)
        {
            let item = this.profileItems.get(profile.name)
            if (item === undefined)
            {
                item = new ProfileItemViewModel(profile.name)
                this.profileItems.set(profile.name, item)
            }
            item.Update(profile.name)
            this.profiles.Add(item)
        }
        const P = SecurityModelEditorViewModel
        this.Raise(P.ProfilesProperty, P.HasProfilesProperty, P.HasNoProfilesProperty, P.SelectedProfileProperty, P.HasSelectedProfileProperty)
    }

    private RebuildFieldGrants(): void
    {
        const draft = this.draft
        this.fieldRows = new ObservableCollection<FieldGrantRowViewModel>()
        const profile = this.selectedProfileId
        if (draft !== undefined && profile !== undefined)
        {
            const secured = [...draft.Catalog.securedFields].sort((a, b) => SecurityModelEditorViewModel.Ordinal(a.concept, b.concept) || SecurityModelEditorViewModel.Ordinal(a.field, b.field))
            for (const field of secured)
            {
                this.fieldRows.Add(new FieldGrantRowViewModel(this, draft, profile, field.concept, field.field))
            }
        }
        this.Raise(SecurityModelEditorViewModel.FieldRowsProperty, SecurityModelEditorViewModel.HasNoFieldRowsProperty)
    }

    private RebuildBusinessUnits(): void
    {
        this.businessUnitRows = new ObservableCollection<BusinessUnitRowViewModel>()
        const org = this.draft?.Org
        if (org !== undefined)
        {
            for (const unit of org.BusinessUnits)
            {
                this.businessUnitRows.Add(new BusinessUnitRowViewModel(this, unit, org))
            }
        }
        this.SyncUnitTree(false)
        this.addTeamCommand.RaiseCanExecuteChanged()
        this.placeUserCommand.RaiseCanExecuteChanged()
        this.Raise(SecurityModelEditorViewModel.BusinessUnitRowsProperty, SecurityModelEditorViewModel.HasNoBusinessUnitsProperty)
    }

    private RebuildUsers(): void
    {
        const choices = this.unitTree.Choices((this.draft?.Org.BusinessUnits ?? []).map(u => u.id))
        this.userRows = new ObservableCollection<UserPlacementRowViewModel>()
        for (const placement of this.draft?.Org.Users ?? [])
        {
            this.userRows.Add(new UserPlacementRowViewModel(this, placement, choices))
        }
        this.Raise(SecurityModelEditorViewModel.UserRowsProperty, SecurityModelEditorViewModel.HasNoUsersProperty)
    }

    private RebuildTeams(): void
    {
        const choices = this.unitTree.Choices((this.draft?.Org.BusinessUnits ?? []).map(u => u.id))
        this.teamRows = new ObservableCollection<TeamRowViewModel>()
        for (const team of this.draft?.Org.Teams ?? [])
        {
            this.teamRows.Add(new TeamRowViewModel(this, team, choices, this.teamMembers))
        }
        this.Raise(SecurityModelEditorViewModel.TeamRowsProperty, SecurityModelEditorViewModel.HasNoTeamsProperty)
    }

    // Re-derives each unit row's depth and parent choices (UnitTree).
    private SyncUnitTree(relabel: boolean): void
    {
        this.unitTree.SyncTree(this.businessUnitRows.ToArray(), relabel)
    }

    // ---- Plumbing ------------------------------------------------------

    // An editing command: disabled without the permission; its body is
    // itself refused while busy (through Apply).
    private EditCommand(run: () => void): RelayCommand
    {
        return new RelayCommand(() => run(), () => this.CanEdit)
    }

    private Input(input: NewInput): string
    {
        return this.inputs.get(input) ?? SecurityModelEditorViewModel.Empty
    }

    private SetInput(input: NewInput, value: unknown): void
    {
        const next = typeof value === 'string' ? value : SecurityModelEditorViewModel.Empty
        const old = this.Input(input)
        if (next === old)
        {
            return
        }
        this.inputs.set(input, next)
        this.RaisePropertyChanged(SecurityModelEditorViewModel.InputProperties.get(input) as string, old, next)
    }

    private SyncDirty(): void
    {
        const next = this.draft?.Dirty ?? false
        if (next === this.dirty)
        {
            return
        }
        this.dirty = next
        const P = SecurityModelEditorViewModel
        this.Raise(P.IsDirtyProperty, P.HasPendingWorkProperty, P.SaveStateTextProperty)
        this.RaiseMutatingCommandsChanged()
    }

    private EnterBusy(): void
    {
        this.busy++
        if (this.busy === 1)
        {
            this.Raise(SecurityModelEditorViewModel.IsBusyProperty)
            this.RaiseMutatingCommandsChanged()
        }
    }

    private ExitBusy(): void
    {
        this.busy--
        if (this.busy === 0)
        {
            this.Raise(SecurityModelEditorViewModel.IsBusyProperty)
            this.RaiseMutatingCommandsChanged()
        }
    }

    // Raises each named property with its current value.
    private Raise(...names: string[]): void
    {
        for (const name of names)
        {
            this.RaisePropertyChanged(name, undefined, Reflect.get(this, name))
        }
    }
}
