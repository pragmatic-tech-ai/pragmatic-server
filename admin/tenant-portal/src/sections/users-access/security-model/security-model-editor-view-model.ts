import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { TenantApiError } from '../../../tenant-api-client.js'
import { AdminCapability } from '../../../shell/admin-capability.js'
import { PendingWork, type IHoldsPendingWork } from '../../../shell/holds-pending-work.js'
import type { TenantSessionService } from '../../../shell/tenant-session-service.js'
import { EnvironmentScopedPageViewModel } from '../environment-scoped-page-view-model.js'
import type { UsersAccessSectionService } from '../users-access-section-service.js'
import { AssignmentEditorViewModel, AssignmentSide } from './assignment-editor-view-model.js'
import { SecurityModelDraft } from './security-model-draft.js'
import { SecurityModelPart, type ISecurityModelEditHost } from './security-model-edit-host.js'
import { LevelCycle } from './security-model-enums.js'
import {
    BusinessUnitRowViewModel, MembershipOverrideRowViewModel, MembershipRuleRowViewModel, OwnershipRuleRowViewModel, TeamRowViewModel,
    UnitChoices, UnitOptionViewModel,
} from './security-model-org-rows.js'
import {
    FieldGrantRowViewModel, LegendEntryViewModel, PrivilegeRowViewModel, ProfileItemViewModel, RecordSharingRowViewModel, RoleItemViewModel,
} from './security-model-role-rows.js'
import { TabSelection } from './tab-selection.js'

// The editor's two modes.
export enum SecurityModelMode
{
    Roles,
    Organization,
}

// The per-role tabs (Roles mode).
export enum RoleTab
{
    Privileges,
    Fields,
    RecordSharing,
    People,
}

// The organization tabs (Organization mode).
export enum OrgTab
{
    BusinessUnits,
    Teams,
    Membership,
    OwnershipRules,
}

// The typed-in values the Add actions read.
enum NewInput
{
    Role,
    Concept,
    Profile,
    FieldConcept,
    Field,
    BusinessUnit,
    Team,
    OwnershipConcept,
}

// The Roles & permissions tab: the security-model editor for the selected
// environment. ONE draft backs every surface (roles and their privileges,
// field profiles, who holds what, the organization), so one dirty flag and
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
    private static readonly OrganizationLabel = 'Organization'
    private static readonly PrivilegesLabel = 'What they can do'
    private static readonly FieldsLabel = 'Fields'
    private static readonly RecordSharingLabel = 'Record sharing'
    private static readonly PeopleLabel = 'People'
    private static readonly BusinessUnitsLabel = 'Business units'
    private static readonly TeamsLabel = 'Teams'
    private static readonly MembershipLabel = 'Membership'
    private static readonly OwnershipRulesLabel = 'Ownership rules'
    private static readonly NoneChoice = '(none)'
    private static readonly UnsavedText = 'Unsaved changes'
    private static readonly NoChangesText = 'No unsaved changes'
    private static readonly NoRecordSharingText = 'This role has no concepts to share yet.'
    private static readonly NoOneAssignedText = 'No one is assigned this role yet.'
    private static readonly AssignedDirectlySuffix = ' assigned directly'
    private static readonly AlsoGrantedPrefix = ', also granted by '
    private static readonly ClaimRuleOne = ' claim rule'
    private static readonly ClaimRuleMany = ' claim rules'
    private static readonly TeamOne = ' team'
    private static readonly TeamMany = ' teams'
    private static readonly AndWord = ' and '
    private static readonly IdOpen = ' ('
    private static readonly IdClose = ')'
    private static readonly Empty = ''
    private static readonly NoRoleId = ''
    private static readonly MaxDepth = 64

    private static readonly SelectedModeProperty = 'SelectedMode'
    private static readonly IsRolesModeProperty = 'IsRolesMode'
    private static readonly IsOrganizationModeProperty = 'IsOrganizationMode'
    private static readonly SelectedRoleTabProperty = 'SelectedRoleTab'
    private static readonly IsPrivilegesTabProperty = 'IsPrivilegesTab'
    private static readonly IsFieldsTabProperty = 'IsFieldsTab'
    private static readonly IsRecordSharingTabProperty = 'IsRecordSharingTab'
    private static readonly IsPeopleTabProperty = 'IsPeopleTab'
    private static readonly SelectedOrgTabProperty = 'SelectedOrgTab'
    private static readonly IsBusinessUnitsTabProperty = 'IsBusinessUnitsTab'
    private static readonly IsTeamsTabProperty = 'IsTeamsTab'
    private static readonly IsMembershipTabProperty = 'IsMembershipTab'
    private static readonly IsOwnershipTabProperty = 'IsOwnershipTab'
    private static readonly RolesProperty = 'Roles'
    private static readonly HasRolesProperty = 'HasRoles'
    private static readonly HasNoRolesProperty = 'HasNoRoles'
    private static readonly SelectedRoleProperty = 'SelectedRole'
    private static readonly HasSelectedRoleProperty = 'HasSelectedRole'
    private static readonly HasNoSelectedRoleProperty = 'HasNoSelectedRole'
    private static readonly SelectedRoleNameProperty = 'SelectedRoleName'
    private static readonly PrivilegeRowsProperty = 'PrivilegeRows'
    private static readonly RecordSharingRowsProperty = 'RecordSharingRows'
    private static readonly HasRecordSharingProperty = 'HasRecordSharing'
    private static readonly HasNoRecordSharingProperty = 'HasNoRecordSharing'
    private static readonly RoleHoldersHeadlineProperty = 'RoleHoldersHeadline'
    private static readonly ProfilesProperty = 'Profiles'
    private static readonly SelectedProfileProperty = 'SelectedProfile'
    private static readonly HasSelectedProfileProperty = 'HasSelectedProfile'
    private static readonly HasNoSelectedProfileProperty = 'HasNoSelectedProfile'
    private static readonly FieldRowsProperty = 'FieldRows'
    private static readonly HasNoFieldRowsProperty = 'HasNoFieldRows'
    private static readonly BusinessUnitRowsProperty = 'BusinessUnitRows'
    private static readonly HasNoBusinessUnitsProperty = 'HasNoBusinessUnits'
    private static readonly TeamRowsProperty = 'TeamRows'
    private static readonly HasNoTeamsProperty = 'HasNoTeams'
    private static readonly MembershipRuleRowsProperty = 'MembershipRuleRows'
    private static readonly HasNoMembershipRulesProperty = 'HasNoMembershipRules'
    private static readonly MembershipOverrideRowsProperty = 'MembershipOverrideRows'
    private static readonly HasNoMembershipOverridesProperty = 'HasNoMembershipOverrides'
    private static readonly OwnershipRuleRowsProperty = 'OwnershipRuleRows'
    private static readonly HasNoOwnershipRulesProperty = 'HasNoOwnershipRules'
    private static readonly IsDirtyProperty = 'IsDirty'
    private static readonly HasPendingWorkProperty = 'HasPendingWork'
    private static readonly SaveStateTextProperty = 'SaveStateText'
    private static readonly IsBusyProperty = 'IsBusy'
    private static readonly InputProperties: ReadonlyMap<NewInput, string> = new Map<NewInput, string>([
        [NewInput.Role, 'NewRoleName'],
        [NewInput.Concept, 'NewConceptName'],
        [NewInput.Profile, 'NewProfileName'],
        [NewInput.FieldConcept, 'NewFieldConcept'],
        [NewInput.Field, 'NewFieldName'],
        [NewInput.BusinessUnit, 'NewBusinessUnitName'],
        [NewInput.Team, 'NewTeamName'],
        [NewInput.OwnershipConcept, 'NewOwnershipConcept'],
    ])

    private static readonly Parts: readonly SecurityModelPart[] = [
        SecurityModelPart.Roles, SecurityModelPart.Privileges, SecurityModelPart.RecordSharing, SecurityModelPart.RoleAssignment,
        SecurityModelPart.Profiles, SecurityModelPart.FieldGrants, SecurityModelPart.ProfileAssignment,
        SecurityModelPart.BusinessUnits, SecurityModelPart.Teams, SecurityModelPart.MembershipRules,
        SecurityModelPart.MembershipOverrides, SecurityModelPart.OwnershipRules,
    ]

    private readonly mode = new TabSelection<SecurityModelMode>([
        [SecurityModelMode.Roles, SecurityModelEditorViewModel.RolesLabel],
        [SecurityModelMode.Organization, SecurityModelEditorViewModel.OrganizationLabel],
    ])
    private readonly roleTab = new TabSelection<RoleTab>([
        [RoleTab.Privileges, SecurityModelEditorViewModel.PrivilegesLabel],
        [RoleTab.Fields, SecurityModelEditorViewModel.FieldsLabel],
        [RoleTab.RecordSharing, SecurityModelEditorViewModel.RecordSharingLabel],
        [RoleTab.People, SecurityModelEditorViewModel.PeopleLabel],
    ])
    private readonly orgTab = new TabSelection<OrgTab>([
        [OrgTab.BusinessUnits, SecurityModelEditorViewModel.BusinessUnitsLabel],
        [OrgTab.Teams, SecurityModelEditorViewModel.TeamsLabel],
        [OrgTab.Membership, SecurityModelEditorViewModel.MembershipLabel],
        [OrgTab.OwnershipRules, SecurityModelEditorViewModel.OwnershipRulesLabel],
    ])

    private draft: SecurityModelDraft | undefined
    private dirty = false
    private busy = 0
    private discarding = false
    private pendingFailure: unknown
    private readonly inputs = new Map<NewInput, string>()
    private readonly roleItems = new Map<string, RoleItemViewModel>()
    private readonly profileItems = new Map<string, ProfileItemViewModel>()
    private readonly unitOptions = new Map<string, UnitOptionViewModel>()
    private readonly noneUnit = new UnitOptionViewModel(undefined, SecurityModelEditorViewModel.NoneChoice)
    private roles = new ObservableCollection<RoleItemViewModel>()
    private privilegeRows = new ObservableCollection<PrivilegeRowViewModel>()
    private recordSharingRows = new ObservableCollection<RecordSharingRowViewModel>()
    private profiles = new ObservableCollection<ProfileItemViewModel>()
    private fieldRows = new ObservableCollection<FieldGrantRowViewModel>()
    private businessUnitRows = new ObservableCollection<BusinessUnitRowViewModel>()
    private teamRows = new ObservableCollection<TeamRowViewModel>()
    private membershipRuleRows = new ObservableCollection<MembershipRuleRowViewModel>()
    private membershipOverrideRows = new ObservableCollection<MembershipOverrideRowViewModel>()
    private ownershipRuleRows = new ObservableCollection<OwnershipRuleRowViewModel>()
    private readonly legend = new ObservableCollection<LegendEntryViewModel>()
    private readonly roleAssignment: AssignmentEditorViewModel
    private readonly profileAssignment: AssignmentEditorViewModel
    private readonly saveCommand: RelayCommand
    private readonly discardCommand: RelayCommand
    private readonly addRoleCommand: RelayCommand
    private readonly deleteRoleCommand: RelayCommand
    private readonly addConceptCommand: RelayCommand
    private readonly addProfileCommand: RelayCommand
    private readonly deleteProfileCommand: RelayCommand
    private readonly addSecuredFieldCommand: RelayCommand
    private readonly addBusinessUnitCommand: RelayCommand
    private readonly addTeamCommand: RelayCommand
    private readonly addMembershipRuleCommand: RelayCommand
    private readonly addMembershipOverrideCommand: RelayCommand
    private readonly addOwnershipRuleCommand: RelayCommand

    public constructor(session: TenantSessionService, protected readonly section: UsersAccessSectionService)
    {
        super(session)
        this.roleAssignment = new AssignmentEditorViewModel(this, AssignmentSide.Role)
        this.profileAssignment = new AssignmentEditorViewModel(this, AssignmentSide.Profile)
        for (const level of LevelCycle)
        {
            this.legend.Add(new LegendEntryViewModel(level))
        }
        const dirtyAndIdle = (): boolean => this.dirty && this.busy === 0
        this.saveCommand = this.MutatingCommand(AdminCapability.Access, () => this.Save(), dirtyAndIdle)
        this.discardCommand = this.MutatingCommand(AdminCapability.Access, () => this.Discard(), dirtyAndIdle)
        this.addRoleCommand = this.EditCommand(() => this.AddRole())
        this.deleteRoleCommand = this.EditCommand(() => this.DeleteRole())
        this.addConceptCommand = this.EditCommand(() => this.AddConcept())
        this.addProfileCommand = this.EditCommand(() => this.AddProfile())
        this.deleteProfileCommand = this.EditCommand(() => this.DeleteProfile())
        this.addSecuredFieldCommand = this.EditCommand(() => this.AddSecuredField())
        this.addBusinessUnitCommand = this.EditCommand(() => this.AddBusinessUnit())
        this.addTeamCommand = this.EditCommand(() => this.AddTeam())
        this.addMembershipRuleCommand = this.EditCommand(() => this.AddMembershipRule())
        this.addMembershipOverrideCommand = this.EditCommand(() => this.AddMembershipOverride())
        this.addOwnershipRuleCommand = this.EditCommand(() => this.AddOwnershipRule())
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
            this.Raise(SecurityModelEditorViewModel.SelectedModeProperty, SecurityModelEditorViewModel.IsRolesModeProperty, SecurityModelEditorViewModel.IsOrganizationModeProperty)
        }
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
            this.Raise(P.SelectedRoleTabProperty, P.IsPrivilegesTabProperty, P.IsFieldsTabProperty, P.IsRecordSharingTabProperty, P.IsPeopleTabProperty)
        }
    }

    public get IsPrivilegesTab(): boolean
    {
        return this.roleTab.Is(RoleTab.Privileges)
    }

    public get IsFieldsTab(): boolean
    {
        return this.roleTab.Is(RoleTab.Fields)
    }

    public get IsRecordSharingTab(): boolean
    {
        return this.roleTab.Is(RoleTab.RecordSharing)
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
            this.Raise(P.SelectedOrgTabProperty, P.IsBusinessUnitsTabProperty, P.IsTeamsTabProperty, P.IsMembershipTabProperty, P.IsOwnershipTabProperty)
        }
    }

    public get IsBusinessUnitsTab(): boolean
    {
        return this.orgTab.Is(OrgTab.BusinessUnits)
    }

    public get IsTeamsTab(): boolean
    {
        return this.orgTab.Is(OrgTab.Teams)
    }

    public get IsMembershipTab(): boolean
    {
        return this.orgTab.Is(OrgTab.Membership)
    }

    public get IsOwnershipTab(): boolean
    {
        return this.orgTab.Is(OrgTab.OwnershipRules)
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

    // The empty hint ("No roles yet. Add a role to start.") shows while the
    // loaded model is still editable.
    public get HasNoRoles(): boolean
    {
        return !this.HasRoles
    }

    public get SelectedRole(): RoleItemViewModel | undefined
    {
        const id = this.draft?.SelectedRoleId
        return id === undefined ? undefined : this.roleItems.get(id)
    }

    // Selecting a role is not an edit (it needs no permission) but, like an
    // edit, it waits for an in-flight load or save.
    public set SelectedRole(item: RoleItemViewModel | undefined)
    {
        const draft = this.draft
        if (!(item instanceof RoleItemViewModel) || draft === undefined || item.Id === draft.SelectedRoleId)
        {
            return
        }
        if (this.busy === 0)
        {
            draft.SelectedRoleId = item.Id
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

    public get NewRoleName(): string
    {
        return this.Input(NewInput.Role)
    }

    public set NewRoleName(value: string)
    {
        this.SetInput(NewInput.Role, value)
    }

    public get AddRoleCommand(): RelayCommand
    {
        return this.addRoleCommand
    }

    public get DeleteRoleCommand(): RelayCommand
    {
        return this.deleteRoleCommand
    }

    // The privilege matrix: one row per concept for the selected role.
    public get PrivilegeRows(): ObservableCollection<PrivilegeRowViewModel>
    {
        return this.privilegeRows
    }

    public get NewConceptName(): string
    {
        return this.Input(NewInput.Concept)
    }

    public set NewConceptName(value: string)
    {
        this.SetInput(NewInput.Concept, value)
    }

    public get AddConceptCommand(): RelayCommand
    {
        return this.addConceptCommand
    }

    public get Legend(): ObservableCollection<LegendEntryViewModel>
    {
        return this.legend
    }

    // Record sharing: derived from the selected role's privileges, read-only.
    public get RecordSharingRows(): ObservableCollection<RecordSharingRowViewModel>
    {
        return this.recordSharingRows
    }

    public get HasRecordSharing(): boolean
    {
        return this.recordSharingRows.Count > 0
    }

    public get HasNoRecordSharing(): boolean
    {
        return !this.HasRecordSharing
    }

    public get NoRecordSharingText(): string
    {
        return SecurityModelEditorViewModel.NoRecordSharingText
    }

    // People: who holds the selected role (counts only; claim rules and team
    // grants assign dynamically, so no names are invented).
    public get RoleHoldersHeadline(): string
    {
        const id = this.draft?.SelectedRoleId
        if (this.draft === undefined || id === undefined)
        {
            return SecurityModelEditorViewModel.Empty
        }
        const holders = this.draft.RoleHoldersFor(id)
        const claims = holders.byClaim.length
        const teams = holders.byTeam.length
        if (holders.directCount === 0 && claims === 0 && teams === 0)
        {
            return SecurityModelEditorViewModel.NoOneAssignedText
        }
        const P = SecurityModelEditorViewModel
        let text = holders.directCount + P.AssignedDirectlySuffix
        const parts: string[] = []
        if (claims > 0)
        {
            parts.push(claims + (claims === 1 ? P.ClaimRuleOne : P.ClaimRuleMany))
        }
        if (teams > 0)
        {
            parts.push(teams + (teams === 1 ? P.TeamOne : P.TeamMany))
        }
        if (parts.length > 0)
        {
            text += P.AlsoGrantedPrefix + parts.join(P.AndWord)
        }
        return text
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

    public get SelectedProfile(): ProfileItemViewModel | undefined
    {
        const id = this.draft?.SelectedProfileId
        return id === undefined ? undefined : this.profileItems.get(id)
    }

    public set SelectedProfile(item: ProfileItemViewModel | undefined)
    {
        const draft = this.draft
        if (!(item instanceof ProfileItemViewModel) || draft === undefined || item.Id === draft.SelectedProfileId)
        {
            return
        }
        if (this.busy === 0)
        {
            draft.SelectedProfileId = item.Id
            this.RebuildProfileScope()
        }
        this.Raise(SecurityModelEditorViewModel.SelectedProfileProperty)
    }

    public get HasSelectedProfile(): boolean
    {
        return this.SelectedProfile !== undefined
    }

    public get HasNoSelectedProfile(): boolean
    {
        return !this.HasSelectedProfile
    }

    public get NewProfileName(): string
    {
        return this.Input(NewInput.Profile)
    }

    public set NewProfileName(value: string)
    {
        this.SetInput(NewInput.Profile, value)
    }

    public get AddProfileCommand(): RelayCommand
    {
        return this.addProfileCommand
    }

    public get DeleteProfileCommand(): RelayCommand
    {
        return this.deleteProfileCommand
    }

    // The secured-field grid for the selected profile.
    public get FieldRows(): ObservableCollection<FieldGrantRowViewModel>
    {
        return this.fieldRows
    }

    public get HasNoFieldRows(): boolean
    {
        return this.fieldRows.Count === 0
    }

    public get NewFieldConcept(): string
    {
        return this.Input(NewInput.FieldConcept)
    }

    public set NewFieldConcept(value: string)
    {
        this.SetInput(NewInput.FieldConcept, value)
    }

    public get NewFieldName(): string
    {
        return this.Input(NewInput.Field)
    }

    public set NewFieldName(value: string)
    {
        this.SetInput(NewInput.Field, value)
    }

    public get AddSecuredFieldCommand(): RelayCommand
    {
        return this.addSecuredFieldCommand
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

    public get MembershipRuleRows(): ObservableCollection<MembershipRuleRowViewModel>
    {
        return this.membershipRuleRows
    }

    public get HasNoMembershipRules(): boolean
    {
        return this.membershipRuleRows.Count === 0
    }

    public get AddMembershipRuleCommand(): RelayCommand
    {
        return this.addMembershipRuleCommand
    }

    public get MembershipOverrideRows(): ObservableCollection<MembershipOverrideRowViewModel>
    {
        return this.membershipOverrideRows
    }

    public get HasNoMembershipOverrides(): boolean
    {
        return this.membershipOverrideRows.Count === 0
    }

    public get AddMembershipOverrideCommand(): RelayCommand
    {
        return this.addMembershipOverrideCommand
    }

    public get OwnershipRuleRows(): ObservableCollection<OwnershipRuleRowViewModel>
    {
        return this.ownershipRuleRows
    }

    public get HasNoOwnershipRules(): boolean
    {
        return this.ownershipRuleRows.Count === 0
    }

    public get NewOwnershipConcept(): string
    {
        return this.Input(NewInput.OwnershipConcept)
    }

    public set NewOwnershipConcept(value: string)
    {
        this.SetInput(NewInput.OwnershipConcept, value)
    }

    public get AddOwnershipRuleCommand(): RelayCommand
    {
        return this.addOwnershipRuleCommand
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
        this.SyncUnitOptions()
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
            case SecurityModelPart.RecordSharing:
                this.RebuildRecordSharing()
                break
            case SecurityModelPart.RoleAssignment:
                this.roleAssignment.Rebuild(this.draft, this.draft?.SelectedRoleId)
                this.Raise(SecurityModelEditorViewModel.RoleHoldersHeadlineProperty)
                break
            case SecurityModelPart.Profiles:
                this.RebuildProfiles()
                break
            case SecurityModelPart.FieldGrants:
                this.RebuildFieldGrants()
                break
            case SecurityModelPart.ProfileAssignment:
                this.profileAssignment.Rebuild(this.draft, this.draft?.SelectedProfileId)
                break
            case SecurityModelPart.BusinessUnits:
                this.RebuildBusinessUnits()
                break
            case SecurityModelPart.Teams:
                this.RebuildTeams()
                break
            case SecurityModelPart.MembershipRules:
                this.RebuildMembershipRules()
                break
            case SecurityModelPart.MembershipOverrides:
                this.RebuildMembershipOverrides()
                break
            case SecurityModelPart.OwnershipRules:
                this.RebuildOwnershipRules()
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
    }

    // A loaded model (null from the server: an empty one) is always shown, so
    // the organization stays editable with no roles yet. A background reload
    // (a live update) keeps unsaved changes; Discard reloads regardless.
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
            return true
        }
        const generation = this.LoadGeneration
        this.EnterBusy()
        try
        {
            const model = await this.Session.Client.GetSecurityModel(environment)
            if (generation === this.LoadGeneration && environment === this.Environment)
            {
                this.SetDraft(SecurityModelDraft.From(model))
            }
            return true
        }
        finally
        {
            this.ExitBusy()
        }
    }

    // PUTs the whole model, then rebases the draft onto what was saved (dirty
    // clears, both selections kept). A 403 shows the Denied state.
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
            this.SetDraft(undefined)
            await this.Refresh()
            return
        }
        if (this.draft === draft)
        {
            const rebased = SecurityModelDraft.From(dto)
            rebased.SelectedRoleId = draft.SelectedRoleId
            rebased.SelectedProfileId = draft.SelectedProfileId
            this.SetDraft(rebased)
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

    private AddRole(): void
    {
        const name = this.Input(NewInput.Role).trim()
        if (name.length > 0 && this.Apply(d => { d.AddRole(name) }))
        {
            this.SetInput(NewInput.Role, SecurityModelEditorViewModel.Empty)
            this.Rebuild()
        }
    }

    private DeleteRole(): void
    {
        const id = this.draft?.SelectedRoleId
        if (id !== undefined && this.Apply(d => d.DeleteRole(id)))
        {
            this.Rebuild()
        }
    }

    private AddConcept(): void
    {
        const name = this.Input(NewInput.Concept).trim()
        if (name.length > 0 && this.Apply(d => d.AddConcept(name)))
        {
            this.SetInput(NewInput.Concept, SecurityModelEditorViewModel.Empty)
            this.Rebuild()
        }
    }

    private AddProfile(): void
    {
        const name = this.Input(NewInput.Profile).trim()
        if (name.length > 0 && this.Apply(d => { d.AddProfile(name) }))
        {
            this.SetInput(NewInput.Profile, SecurityModelEditorViewModel.Empty)
            this.Rebuild()
        }
    }

    private DeleteProfile(): void
    {
        const id = this.draft?.SelectedProfileId
        if (id !== undefined && this.Apply(d => d.DeleteProfile(id)))
        {
            this.Rebuild()
        }
    }

    private AddSecuredField(): void
    {
        const concept = this.Input(NewInput.FieldConcept).trim()
        const field = this.Input(NewInput.Field).trim()
        if (concept.length > 0 && field.length > 0 && this.Apply(d => d.AddSecuredField(concept, field)))
        {
            this.SetInput(NewInput.FieldConcept, SecurityModelEditorViewModel.Empty)
            this.SetInput(NewInput.Field, SecurityModelEditorViewModel.Empty)
            this.Rebuild()
        }
    }

    private AddBusinessUnit(): void
    {
        const name = this.Input(NewInput.BusinessUnit).trim()
        if (name.length > 0 && this.Apply(d => { d.Org.AddBusinessUnit(name) }))
        {
            this.SetInput(NewInput.BusinessUnit, SecurityModelEditorViewModel.Empty)
            this.Rebuild()
        }
    }

    private AddTeam(): void
    {
        const name = this.Input(NewInput.Team).trim()
        if (name.length > 0 && this.Apply(d => { d.Org.AddTeam(name) }))
        {
            this.SetInput(NewInput.Team, SecurityModelEditorViewModel.Empty)
            this.Rebuild()
        }
    }

    private AddMembershipRule(): void
    {
        if (this.Apply(d => d.Org.AddMembershipRule()))
        {
            this.Rebuild()
        }
    }

    private AddMembershipOverride(): void
    {
        if (this.Apply(d => d.Org.AddMembershipOverride()))
        {
            this.Rebuild()
        }
    }

    private AddOwnershipRule(): void
    {
        const concept = this.Input(NewInput.OwnershipConcept).trim()
        if (concept.length > 0 && this.Apply(d => d.Org.AddOwnershipRule(concept)))
        {
            this.SetInput(NewInput.OwnershipConcept, SecurityModelEditorViewModel.Empty)
            this.Rebuild()
        }
    }

    // ---- Rebuilding ----------------------------------------------------

    private SetDraft(draft: SecurityModelDraft | undefined): void
    {
        this.draft = draft
        this.Rebuild()
    }

    // The selected role changed: its matrix, record sharing and holders follow.
    private RebuildRoleScope(): void
    {
        this.RebuildPrivileges()
        this.RebuildRecordSharing()
        this.RebuildPart(SecurityModelPart.RoleAssignment)
        const P = SecurityModelEditorViewModel
        this.Raise(P.HasSelectedRoleProperty, P.HasNoSelectedRoleProperty, P.SelectedRoleNameProperty)
    }

    private RebuildProfileScope(): void
    {
        this.RebuildFieldGrants()
        this.RebuildPart(SecurityModelPart.ProfileAssignment)
        const P = SecurityModelEditorViewModel
        this.Raise(P.HasSelectedProfileProperty, P.HasNoSelectedProfileProperty)
    }

    private RebuildRoles(): void
    {
        const draft = this.draft
        const roles = draft?.Roles ?? []
        const live = new Set<string>(roles.map(r => r.id))
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
            let item = this.roleItems.get(role.id)
            if (item === undefined)
            {
                item = new RoleItemViewModel(role.id)
                this.roleItems.set(role.id, item)
            }
            item.Update(role.name, draft?.DirectHolderCount(role.id) ?? 0)
            this.roles.Add(item)
        }
        const P = SecurityModelEditorViewModel
        this.Raise(P.RolesProperty, P.HasRolesProperty, P.HasNoRolesProperty, P.SelectedRoleProperty,
            P.HasSelectedRoleProperty, P.HasNoSelectedRoleProperty, P.SelectedRoleNameProperty)
    }

    private RebuildPrivileges(): void
    {
        const draft = this.draft
        this.privilegeRows = new ObservableCollection<PrivilegeRowViewModel>()
        if (draft !== undefined && draft.SelectedRoleId !== undefined)
        {
            for (const concept of draft.Concepts)
            {
                this.privilegeRows.Add(new PrivilegeRowViewModel(this, draft, concept))
            }
        }
        this.Raise(SecurityModelEditorViewModel.PrivilegeRowsProperty)
    }

    private RebuildRecordSharing(): void
    {
        const draft = this.draft
        this.recordSharingRows = new ObservableCollection<RecordSharingRowViewModel>()
        for (const row of draft?.RecordSharingFor(draft.SelectedRoleId ?? SecurityModelEditorViewModel.NoRoleId) ?? [])
        {
            this.recordSharingRows.Add(new RecordSharingRowViewModel(row))
        }
        const P = SecurityModelEditorViewModel
        this.Raise(P.RecordSharingRowsProperty, P.HasRecordSharingProperty, P.HasNoRecordSharingProperty)
    }

    private RebuildProfiles(): void
    {
        const profiles = this.draft?.Profiles ?? []
        const live = new Set<string>(profiles.map(p => p.id))
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
            let item = this.profileItems.get(profile.id)
            if (item === undefined)
            {
                item = new ProfileItemViewModel(profile.id)
                this.profileItems.set(profile.id, item)
            }
            item.Update(profile.name)
            this.profiles.Add(item)
        }
        const P = SecurityModelEditorViewModel
        this.Raise(P.ProfilesProperty, P.SelectedProfileProperty, P.HasSelectedProfileProperty, P.HasNoSelectedProfileProperty)
    }

    private RebuildFieldGrants(): void
    {
        const draft = this.draft
        this.fieldRows = new ObservableCollection<FieldGrantRowViewModel>()
        if (draft !== undefined && draft.SelectedProfileId !== undefined)
        {
            for (const field of draft.SecuredFields)
            {
                this.fieldRows.Add(new FieldGrantRowViewModel(this, draft, field.concept, field.field))
            }
        }
        this.Raise(SecurityModelEditorViewModel.FieldRowsProperty, SecurityModelEditorViewModel.HasNoFieldRowsProperty)
    }

    private RebuildBusinessUnits(): void
    {
        this.businessUnitRows = new ObservableCollection<BusinessUnitRowViewModel>()
        for (const unit of this.draft?.Org.BusinessUnits ?? [])
        {
            this.businessUnitRows.Add(new BusinessUnitRowViewModel(this, unit))
        }
        this.SyncUnitTree(false)
        this.Raise(SecurityModelEditorViewModel.BusinessUnitRowsProperty, SecurityModelEditorViewModel.HasNoBusinessUnitsProperty)
    }

    private RebuildTeams(): void
    {
        const choices = this.AllUnitChoices()
        this.teamRows = new ObservableCollection<TeamRowViewModel>()
        for (const team of this.draft?.Org.Teams ?? [])
        {
            this.teamRows.Add(new TeamRowViewModel(this, team, choices))
        }
        this.Raise(SecurityModelEditorViewModel.TeamRowsProperty, SecurityModelEditorViewModel.HasNoTeamsProperty)
    }

    private RebuildMembershipRules(): void
    {
        const org = this.draft?.Org
        const choices = this.AllUnitChoices()
        this.membershipRuleRows = new ObservableCollection<MembershipRuleRowViewModel>()
        org?.Membership.claimsMapping.forEach((rule, index) =>
        {
            this.membershipRuleRows.Add(new MembershipRuleRowViewModel(this, index, rule, choices, org.Teams))
        })
        this.Raise(SecurityModelEditorViewModel.MembershipRuleRowsProperty, SecurityModelEditorViewModel.HasNoMembershipRulesProperty)
    }

    private RebuildMembershipOverrides(): void
    {
        const org = this.draft?.Org
        const choices = this.AllUnitChoices()
        this.membershipOverrideRows = new ObservableCollection<MembershipOverrideRowViewModel>()
        org?.Membership.overrides.forEach((entry, index) =>
        {
            this.membershipOverrideRows.Add(new MembershipOverrideRowViewModel(this, index, entry, choices, org.Teams))
        })
        this.Raise(SecurityModelEditorViewModel.MembershipOverrideRowsProperty, SecurityModelEditorViewModel.HasNoMembershipOverridesProperty)
    }

    private RebuildOwnershipRules(): void
    {
        this.ownershipRuleRows = new ObservableCollection<OwnershipRuleRowViewModel>()
        for (const rule of this.draft?.Org.OwnershipRules ?? [])
        {
            this.ownershipRuleRows.Add(new OwnershipRuleRowViewModel(this, rule))
        }
        this.Raise(SecurityModelEditorViewModel.OwnershipRuleRowsProperty, SecurityModelEditorViewModel.HasNoOwnershipRulesProperty)
    }

    // Keeps one choice object per unit (labels follow renames; a duplicate
    // name gets its id appended so the choices stay distinct).
    private SyncUnitOptions(): void
    {
        const units = this.draft?.Org.BusinessUnits ?? []
        const counts = new Map<string, number>()
        for (const unit of units)
        {
            counts.set(unit.name, (counts.get(unit.name) ?? 0) + 1)
        }
        const live = new Set<string>(units.map(u => u.id))
        for (const id of [...this.unitOptions.keys()])
        {
            if (!live.has(id))
            {
                this.unitOptions.delete(id)
            }
        }
        for (const unit of units)
        {
            const P = SecurityModelEditorViewModel
            const label = (counts.get(unit.name) ?? 0) > 1 ? unit.name + P.IdOpen + unit.id + P.IdClose : unit.name
            const option = this.unitOptions.get(unit.id)
            if (option === undefined)
            {
                this.unitOptions.set(unit.id, new UnitOptionViewModel(unit.id, label))
            }
            else
            {
                option.SetLabel(label)
            }
        }
    }

    private AllUnitChoices(): UnitChoices
    {
        return new UnitChoices(this.noneUnit, this.unitOptions, (this.draft?.Org.BusinessUnits ?? []).map(u => u.id))
    }

    // Each unit's depth and parent choices (every unit but itself and its
    // descendants, so the picker never offers a cycle).
    private SyncUnitTree(relabel: boolean): void
    {
        const rows = this.businessUnitRows.ToArray()
        const parents = new Map<string, string | undefined>(rows.map(r => [r.Id, r.Parent]))
        const children = new Map<string, string[]>()
        for (const row of rows)
        {
            if (row.Parent !== undefined)
            {
                children.set(row.Parent, [...(children.get(row.Parent) ?? []), row.Id])
            }
        }
        for (const row of rows)
        {
            const excluded = SecurityModelEditorViewModel.DescendantsOf(row.Id, children)
            excluded.add(row.Id)
            const ids = rows.map(r => r.Id).filter(id => !excluded.has(id))
            row.SetTree(SecurityModelEditorViewModel.DepthOf(row.Id, parents), new UnitChoices(this.noneUnit, this.unitOptions, ids), relabel)
        }
    }

    private static DescendantsOf(id: string, children: ReadonlyMap<string, readonly string[]>): Set<string>
    {
        const found = new Set<string>()
        const pending = [...(children.get(id) ?? [])]
        while (pending.length > 0)
        {
            const next = pending.pop() as string
            if (!found.has(next))
            {
                found.add(next)
                pending.push(...(children.get(next) ?? []))
            }
        }
        return found
    }

    // Depth along the parent chain (bounded, so a bad cycle cannot loop).
    private static DepthOf(id: string, parents: ReadonlyMap<string, string | undefined>): number
    {
        let depth = 0
        let parent = parents.get(id)
        while (parent !== undefined && parents.has(parent) && depth < SecurityModelEditorViewModel.MaxDepth)
        {
            depth++
            parent = parents.get(parent)
        }
        return depth
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
