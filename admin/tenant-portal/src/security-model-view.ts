import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Button, ComboBox } from '@pragmatic-tech-ai/mural/framework'
import { Checkbox } from '@pragmatic-tech-ai/mural/framework/toggles/checkbox.js'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ScreenHost } from './kit/screen-host.js'
import type { ScreenHostInputs } from './kit/screen-host.js'
import { PillKind } from './kit/pill-kinds.js'
import { Section } from './kit/section.js'
import { StatusPill } from './kit/status-pill.js'
import { Tabs } from './kit/tabs.js'
import { AssignmentSide } from './assignment-side.js'
import type { AssignmentClaimRow } from './assignment-claim-row.js'
import type { AssignmentPrincipalRow } from './assignment-principal-row.js'
import type { AssignmentTeamRow } from './assignment-team-row.js'
import type { BusinessUnitRow } from './business-unit-row.js'
import type { MembershipOverrideRow } from './membership-override-row.js'
import type { MembershipRuleRow } from './membership-rule-row.js'
import type { OwnershipRuleRow } from './ownership-rule-row.js'
import type { TeamRow } from './team-row.js'
import type { FieldGrantRow } from './field-grant-row.js'
import type { PrivilegeRow } from './privilege-row.js'
import { AccessLevel, Actions, FieldPermission, FieldPermissions, LevelCycle, PrivilegeAction } from './security-model-draft.js'
import { SecurityModelState, SecurityModelViewModel } from './security-model-view-model.js'
import type { ISecurityModelEnvSource } from './security-model-view-model.js'
import { TenantViewBase } from './tenant-view-base.js'

// Tenant admin security-model editor: an outer Roles / Organization mode switch over ONE shared
// draft and ONE save bar. Roles = a role list over three kit tabs (What they can do = the
// privilege matrix, Fields = the field-security grid, Record sharing = a read-only derived view);
// Organization = four tenant-wide sub-editors (business units, teams, membership, ownership rules).
// Scalar org edits mutate the draft in place and only restyle the save bar (like MakeCell), so a
// focused control is never torn down under its own edit; set-shape edits rebuild.
export class SecurityModelView extends TenantViewBase
{
    public static readonly WhatTheyCanDoLabel = 'What they can do'
    public static readonly FieldsLabel = 'Fields'
    public static readonly RecordSharingLabel = 'Record sharing'
    public static readonly PeopleLabel = 'People'
    public static readonly NoOneAssignedText = 'No one is assigned this role yet. Add people, claim rules or teams below.'
    public static readonly NoOneHasProfileText = 'No one has this profile yet. Add people, claim rules or teams below.'
    public static readonly WhoHasProfileTitle = 'Who has this profile'
    public static readonly ByPersonTitle = 'By person'
    public static readonly ByClaimTitle = 'By claim'
    public static readonly ByTeamTitle = 'By team'
    public static readonly AddPersonLabel = 'Add person'
    public static readonly AddClaimGrantLabel = 'Add claim'
    public static readonly AddTeamGrantLabel = 'Add team'
    public static readonly PickTeamChoice = '(pick a team)'
    public static readonly DirectSuffix = ' direct'
    private static readonly DirectSeparator = '  ·  '
    public static readonly AssignedDirectlySuffix = ' assigned directly'
    private static readonly AlsoGrantedPrefix = ', also granted by '
    private static readonly ClaimRuleOne = ' claim rule'
    private static readonly ClaimRuleMany = ' claim rules'
    private static readonly TeamOne = ' team'
    private static readonly TeamMany = ' teams'
    private static readonly AssignmentPrincipalPlaceholder = 'Person (principal id)'
    public static readonly RolesModeLabel = 'Roles'
    public static readonly OrganizationModeLabel = 'Organization'
    public static readonly BusinessUnitsLabel = 'Business units'
    public static readonly TeamsLabel = 'Teams'
    public static readonly MembershipLabel = 'Membership'
    public static readonly OwnershipRulesLabel = 'Ownership rules'
    public static readonly NoBusinessUnitsText = 'No business units yet. Add one to build your organization tree.'
    public static readonly NoTeamsText = 'No teams yet. Add one to group people.'
    public static readonly NoMembershipRulesText = 'No claim rules yet.'
    public static readonly NoMembershipOverridesText = 'No per-person overrides yet.'
    public static readonly NoOwnershipRulesText = 'No ownership rules yet. Add one per concept.'
    public static readonly NoRecordSharingText = 'This role has no concepts to share yet.'
    public static readonly AddBusinessUnitLabel = 'Add business unit'
    public static readonly AddTeamLabel = 'Add team'
    public static readonly AddMembershipRuleLabel = 'Add claim rule'
    public static readonly AddMembershipOverrideLabel = 'Add override'
    public static readonly AddOwnershipRuleLabel = 'Add ownership rule'
    public static readonly CanShareLabel = 'Can share'
    public static readonly CanAssignLabel = 'Can assign'
    public static readonly NoneChoice = '(none)'
    public static readonly ClaimRulesTitle = 'Claim rules'
    public static readonly OverridesTitle = 'Per-person overrides'
    private static readonly BusinessUnitPlaceholder = 'New business unit name'
    private static readonly TeamPlaceholder = 'New team name'
    private static readonly OwnershipConceptPlaceholder = 'Concept to own'
    private static readonly ClaimPlaceholder = 'Claim'
    private static readonly ClaimValuePlaceholder = 'Value'
    private static readonly PrincipalPlaceholder = 'Principal id'
    private static readonly OwningKindPlaceholder = 'Owning unit source kind'
    private static readonly OwningValuePlaceholder = 'Owning unit source value'
    private static readonly OwnerKindPlaceholder = 'Owner source kind'
    private static readonly OwnerValuePlaceholder = 'Owner source value'
    private static readonly IndentUnit = '\u00a0\u00a0\u00a0\u00a0'
    private static readonly IdOpen = ' ('
    private static readonly IdClose = ')'
    private static readonly MaxDepth = 64
    public static readonly SelectedMark = '\u25cf '
    public static readonly EmptyTitle = 'No roles yet. Add a role to start.'
    public static readonly NoEnvironmentTitle = 'No environments available.'
    public static readonly ErrorTitle = 'Could not load the security model.'
    public static readonly DeniedWhat = 'The security model'
    public static readonly DeniedNeed = 'the Manage users & access permission'
    public static readonly UnsavedText = 'Unsaved changes'
    public static readonly NoChangesText = 'No unsaved changes'
    public static readonly SaveLabel = 'Save'
    public static readonly DiscardLabel = 'Discard'
    public static readonly AddRoleLabel = 'Add role'
    public static readonly DeleteRoleLabel = 'Delete role'
    public static readonly AddConceptLabel = 'Add concept'
    public static readonly AddProfileLabel = 'Add profile'
    public static readonly DeleteProfileLabel = 'Delete profile'
    public static readonly AddSecuredFieldLabel = 'Add secured field'
    public static readonly RemoveLabel = 'Remove'
    public static readonly RolePlaceholder = 'New role name'
    public static readonly ConceptPlaceholder = 'New concept name'
    public static readonly ProfilePlaceholder = 'New profile name'
    public static readonly FieldConceptPlaceholder = 'Concept'
    public static readonly FieldPlaceholder = 'Field'
    public static readonly NoRoleSelectedText = 'Select or add a role to edit what it can do.'
    public static readonly NoProfileSelectedText = 'Select or add a field profile to edit its field access.'
    public static readonly ConceptHeader = 'Concept'
    public static readonly FieldHeader = 'Field'
    public static readonly LegendHeading = 'Access levels'
    public static readonly LegendSeparator = ' = '

    public static readonly NoneSymbol = '\u25cb'
    public static readonly UserSymbol = '\u25d4'
    public static readonly BusinessUnitSymbol = '\u25d1'
    public static readonly BusinessUnitAndChildrenSymbol = '\u25d5'
    public static readonly OrganizationSymbol = '\u25cf'
    public static readonly NoneName = 'None'
    public static readonly UserName = 'User'
    public static readonly BusinessUnitName = 'Business unit'
    public static readonly BusinessUnitAndChildrenName = 'Business unit and children'
    public static readonly OrganizationName = 'Organization'

    public static readonly CreateLabel = 'Create'
    public static readonly ReadLabel = 'Read'
    public static readonly UpdateLabel = 'Update'
    public static readonly DeleteLabel = 'Delete'
    public static readonly AppendLabel = 'Append'
    public static readonly AppendToLabel = 'Append to'
    public static readonly AssignLabel = 'Assign'
    public static readonly ShareLabel = 'Share'

    // Plain-language sentence fragments (SentenceFor).
    public static readonly NoAccessSentence = "Can't see or change this."
    private static readonly SentenceStart = 'Can '
    private static readonly SentenceEnd = '.'
    private static readonly AtWord = ' at '
    private static readonly LevelWord = ' level'
    private static readonly AndWord = ' and '
    private static readonly CommaSpace = ', '
    private static readonly CommaAndSpace = ', and '
    private static readonly CreateVerb = 'create'
    private static readonly ReadVerb = 'read'
    private static readonly UpdateVerb = 'update'
    private static readonly DeleteVerb = 'delete'
    private static readonly AppendVerb = 'append'
    private static readonly AppendToVerb = 'append to'
    private static readonly AssignVerb = 'assign'
    private static readonly ShareVerb = 'share'
    private static readonly UserScope = 'user'
    private static readonly BusinessUnitScope = 'business unit'
    private static readonly BusinessUnitAndChildrenScope = 'business unit and children'
    private static readonly OrganizationScope = 'organization'

    private static readonly CellKeySeparator = '|'

    public static readonly Symbols: ReadonlyMap<AccessLevel, string> = new Map<AccessLevel, string>([
        [AccessLevel.None, SecurityModelView.NoneSymbol],
        [AccessLevel.User, SecurityModelView.UserSymbol],
        [AccessLevel.BusinessUnit, SecurityModelView.BusinessUnitSymbol],
        [AccessLevel.BusinessUnitAndChildren, SecurityModelView.BusinessUnitAndChildrenSymbol],
        [AccessLevel.Organization, SecurityModelView.OrganizationSymbol],
    ])

    public static readonly LevelNames: ReadonlyMap<AccessLevel, string> = new Map<AccessLevel, string>([
        [AccessLevel.None, SecurityModelView.NoneName],
        [AccessLevel.User, SecurityModelView.UserName],
        [AccessLevel.BusinessUnit, SecurityModelView.BusinessUnitName],
        [AccessLevel.BusinessUnitAndChildren, SecurityModelView.BusinessUnitAndChildrenName],
        [AccessLevel.Organization, SecurityModelView.OrganizationName],
    ])

    public static readonly ActionLabels: ReadonlyMap<PrivilegeAction, string> = new Map<PrivilegeAction, string>([
        [PrivilegeAction.Create, SecurityModelView.CreateLabel],
        [PrivilegeAction.Read, SecurityModelView.ReadLabel],
        [PrivilegeAction.Update, SecurityModelView.UpdateLabel],
        [PrivilegeAction.Delete, SecurityModelView.DeleteLabel],
        [PrivilegeAction.Append, SecurityModelView.AppendLabel],
        [PrivilegeAction.AppendTo, SecurityModelView.AppendToLabel],
        [PrivilegeAction.Assign, SecurityModelView.AssignLabel],
        [PrivilegeAction.Share, SecurityModelView.ShareLabel],
    ])

    public static readonly PermissionLabels: ReadonlyMap<FieldPermission, string> = new Map<FieldPermission, string>([
        [FieldPermission.Read, SecurityModelView.ReadLabel],
        [FieldPermission.Update, SecurityModelView.UpdateLabel],
        [FieldPermission.Create, SecurityModelView.CreateLabel],
    ])

    private static readonly ActionVerbs: ReadonlyMap<PrivilegeAction, string> = new Map<PrivilegeAction, string>([
        [PrivilegeAction.Create, SecurityModelView.CreateVerb],
        [PrivilegeAction.Read, SecurityModelView.ReadVerb],
        [PrivilegeAction.Update, SecurityModelView.UpdateVerb],
        [PrivilegeAction.Delete, SecurityModelView.DeleteVerb],
        [PrivilegeAction.Append, SecurityModelView.AppendVerb],
        [PrivilegeAction.AppendTo, SecurityModelView.AppendToVerb],
        [PrivilegeAction.Assign, SecurityModelView.AssignVerb],
        [PrivilegeAction.Share, SecurityModelView.ShareVerb],
    ])

    private static readonly LevelScopes: ReadonlyMap<AccessLevel, string> = new Map<AccessLevel, string>([
        [AccessLevel.User, SecurityModelView.UserScope],
        [AccessLevel.BusinessUnit, SecurityModelView.BusinessUnitScope],
        [AccessLevel.BusinessUnitAndChildren, SecurityModelView.BusinessUnitAndChildrenScope],
        [AccessLevel.Organization, SecurityModelView.OrganizationScope],
    ])

    private readonly vm: SecurityModelViewModel
    private readonly roleTabs: Tabs
    private readonly mode: Tabs
    private readonly orgTabs: Tabs
    private readonly rolesPane = new StackPanel()
    private readonly orgPane = new StackPanel()
    private readonly recordHost = new StackPanel()
    private readonly peopleHost = new StackPanel()
    private readonly addRolePrincipalBox = new TextBox()
    private readonly addProfilePrincipalBox = new TextBox()
    private readonly addRolePrincipalStrip = new StackPanel()
    private readonly addProfilePrincipalStrip = new StackPanel()
    private readonly businessUnitHost = new StackPanel()
    private readonly teamHost = new StackPanel()
    private readonly membershipHost = new StackPanel()
    private readonly ownershipHost = new StackPanel()
    private readonly businessUnitBox = new TextBox()
    private readonly teamBox = new TextBox()
    private readonly ownershipBox = new TextBox()
    private readonly addBusinessUnitStrip = new StackPanel()
    private readonly addTeamStrip = new StackPanel()
    private readonly addMembershipRuleStrip = new StackPanel()
    private readonly addMembershipOverrideStrip = new StackPanel()
    private readonly addOwnershipStrip = new StackPanel()
    private readonly ruleBody = new StackPanel()
    private readonly overrideBody = new StackPanel()
    private readonly ruleSection: Section
    private readonly overrideSection: Section
    private readonly rowSubscriptions: IDisposable[] = []
    private readonly privilegeHost = new StackPanel()
    private readonly fieldHost = new StackPanel()
    private readonly body = new StackPanel()
    private readonly stateHost: ScreenHost
    private readonly roleBox = new TextBox()
    private readonly conceptBox = new TextBox()
    private readonly profileBox = new TextBox()
    private readonly fieldConceptBox = new TextBox()
    private readonly fieldBox = new TextBox()
    private readonly addRoleStrip = new StackPanel()
    private readonly addConceptStrip = new StackPanel()
    private readonly addProfileStrip = new StackPanel()
    private readonly addFieldStrip = new StackPanel()
    private readonly saveBar = new StackPanel()
    private readonly saveText = new TextBlock()
    private readonly saveButton: Button
    private readonly discardButton: Button
    private readonly subscriptions: IDisposable[] = []
    private readonly cells = new Map<string, Button>()
    private readonly grants = new Map<string, Checkbox>()

    public constructor(source: ISecurityModelEnvSource)
    {
        super()
        this.vm = new SecurityModelViewModel(source)
        this.roleBox.Placeholder = SecurityModelView.RolePlaceholder
        this.conceptBox.Placeholder = SecurityModelView.ConceptPlaceholder
        this.profileBox.Placeholder = SecurityModelView.ProfilePlaceholder
        this.fieldConceptBox.Placeholder = SecurityModelView.FieldConceptPlaceholder
        this.fieldBox.Placeholder = SecurityModelView.FieldPlaceholder
        this.privilegeHost.Orientation = Orientation.Vertical
        this.fieldHost.Orientation = Orientation.Vertical
        this.body.Orientation = Orientation.Vertical
        this.businessUnitBox.Placeholder = SecurityModelView.BusinessUnitPlaceholder
        this.teamBox.Placeholder = SecurityModelView.TeamPlaceholder
        this.ownershipBox.Placeholder = SecurityModelView.OwnershipConceptPlaceholder
        for (const panel of [this.rolesPane, this.orgPane, this.recordHost, this.peopleHost, this.businessUnitHost, this.teamHost, this.membershipHost, this.ownershipHost])
        {
            panel.Orientation = Orientation.Vertical
        }
        this.roleTabs = new Tabs({
            entries: [
                { label: SecurityModelView.WhatTheyCanDoLabel, content: this.privilegeHost },
                { label: SecurityModelView.FieldsLabel, content: this.fieldHost },
                { label: SecurityModelView.RecordSharingLabel, content: this.recordHost },
                { label: SecurityModelView.PeopleLabel, content: this.peopleHost },
            ],
        })
        this.orgTabs = new Tabs({
            entries: [
                { label: SecurityModelView.BusinessUnitsLabel, content: this.businessUnitHost },
                { label: SecurityModelView.TeamsLabel, content: this.teamHost },
                { label: SecurityModelView.MembershipLabel, content: this.membershipHost },
                { label: SecurityModelView.OwnershipRulesLabel, content: this.ownershipHost },
            ],
        })
        this.mode = new Tabs({
            entries: [
                { label: SecurityModelView.RolesModeLabel, content: this.rolesPane },
                { label: SecurityModelView.OrganizationModeLabel, content: this.orgPane },
            ],
        })
        this.ruleBody.Orientation = Orientation.Vertical
        this.overrideBody.Orientation = Orientation.Vertical
        this.ruleSection = new Section({ title: SecurityModelView.ClaimRulesTitle, body: this.ruleBody })
        this.overrideSection = new Section({ title: SecurityModelView.OverridesTitle, body: this.overrideBody })
        this.orgPane.AddChild(this.orgTabs)
        this.stateHost = new ScreenHost({ loading: true, allowed: true, isEmpty: false, error: false })
        this.saveButton = this.MakeButton(SecurityModelView.SaveLabel, () => { void this.Act(() => this.vm.Save()) })
        this.discardButton = this.MakeButton(SecurityModelView.DiscardLabel, () => { void this.Act(() => this.vm.Revert()) })
        this.BuildAddStrips()
        this.BuildOrgAddStrips()
        this.BuildSaveBar()
        const rerender = (): void => this.Render()
        const vmType = SecurityModelViewModel
        this.subscriptions.push(this.vm.PropertyChanged(vmType.EnvironmentsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.SelectedEnvironmentProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.RolesProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.SelectedRoleIdProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.PrivilegeRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.ProfilesProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.SelectedProfileIdProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.FieldRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.BusinessUnitRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.TeamRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.MembershipRuleRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.MembershipOverrideRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.OwnershipRuleRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.RecordSharingRowsProperty).subscribe(rerender))
        // Add/remove of an assignment replaces the row arrays (rebuild); a scalar claim edit uses RefreshDirty and raises none of these.
        this.subscriptions.push(this.vm.PropertyChanged(vmType.RoleClaimRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.RolePrincipalRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.RoleTeamRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.ProfileClaimRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.ProfilePrincipalRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.ProfileTeamRowsProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.StateProperty).subscribe(rerender))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.ErrorProperty).subscribe(rerender))
        // Dirty and Busy only restyle the save bar, so a cell is never torn down under its own click.
        this.subscriptions.push(this.vm.PropertyChanged(vmType.DirtyProperty).subscribe(() => this.UpdateSaveBar()))
        this.subscriptions.push(this.vm.PropertyChanged(vmType.BusyProperty).subscribe(() => this.UpdateSaveBar()))
        this.Render()
    }

    // Plain-language summary of what a role can do with one concept.
    public static SentenceFor(row: PrivilegeRow): string
    {
        const parts: string[] = []
        for (const action of Actions)
        {
            const scope = SecurityModelView.LevelScopes.get(row.LevelFor(action))
            if (scope !== undefined)
            {
                parts.push((SecurityModelView.ActionVerbs.get(action) ?? action) + SecurityModelView.AtWord + scope + SecurityModelView.LevelWord)
            }
        }
        if (parts.length === 0)
        {
            return SecurityModelView.NoAccessSentence
        }
        return SecurityModelView.SentenceStart + SecurityModelView.JoinParts(parts) + SecurityModelView.SentenceEnd
    }

    public static SymbolOf(level: AccessLevel): string
    {
        return SecurityModelView.Symbols.get(level) ?? SecurityModelView.NoneSymbol
    }

    private static JoinParts(parts: readonly string[]): string
    {
        if (parts.length === 1)
        {
            return parts[0]
        }
        if (parts.length === 2)
        {
            return parts[0] + SecurityModelView.AndWord + parts[1]
        }
        const head = parts.slice(0, parts.length - 1).join(SecurityModelView.CommaSpace)
        return head + SecurityModelView.CommaAndSpace + parts[parts.length - 1]
    }

    private static CellKey(concept: string, part: string): string
    {
        return concept + SecurityModelView.CellKeySeparator + part
    }

    // Test seam: the outer Roles / Organization mode switch.
    public get Mode(): Tabs
    {
        return this.mode
    }

    // Test seam: the per-role tabs (What they can do | Fields | Record sharing).
    public get RoleTabs(): Tabs
    {
        return this.roleTabs
    }

    // Test seam: the Organization sub-editor tabs.
    public get OrgTabs(): Tabs
    {
        return this.orgTabs
    }

    // Test seam: the Roles pane (role strip, add strip, per-role tabs).
    public get RolesPane(): StackPanel
    {
        return this.rolesPane
    }

    // Test seam: the Organization pane.
    public get OrgPane(): StackPanel
    {
        return this.orgPane
    }

    // Test seam: the Record sharing tab content.
    public get RecordHost(): StackPanel
    {
        return this.recordHost
    }

    // Test seam: the People tab content.
    public get PeopleHost(): StackPanel
    {
        return this.peopleHost
    }

    // Test seam: the Business units sub-editor body.
    public get BusinessUnitHost(): StackPanel
    {
        return this.businessUnitHost
    }

    // Test seam: the Teams sub-editor body.
    public get TeamHost(): StackPanel
    {
        return this.teamHost
    }

    // Test seam: the Membership sub-editor body.
    public get MembershipHost(): StackPanel
    {
        return this.membershipHost
    }

    // Test seam: the Ownership rules sub-editor body.
    public get OwnershipHost(): StackPanel
    {
        return this.ownershipHost
    }

    // Test seam: count of live subscriptions (zero after Dispose).
    public get SubscriptionCount(): number
    {
        return this.subscriptions.length + this.rowSubscriptions.length
    }

    public get Vm(): SecurityModelViewModel
    {
        return this.vm
    }

    // Test seam: the Fields tab content.
    public get FieldHost(): StackPanel
    {
        return this.fieldHost
    }

    // Test seam: the What-they-can-do tab content.
    public get PrivilegeHost(): StackPanel
    {
        return this.privilegeHost
    }

    // Test seam: the state host.
    public get StateHost(): ScreenHost
    {
        return this.stateHost
    }

    // Test seam: the state host when the capability is withheld, else undefined.
    public get DeniedHost(): ScreenHost | undefined
    {
        return this.vm.State === SecurityModelState.Forbidden ? this.stateHost : undefined
    }

    public get SaveBarText(): string
    {
        return this.saveText.Text
    }

    public get SaveEnabled(): boolean
    {
        return this.saveButton.IsEnabled
    }

    public get DiscardEnabled(): boolean
    {
        return this.discardButton.IsEnabled
    }

    // Test seam: the live matrix cell for (concept, action).
    public CellFor(concept: string, action: PrivilegeAction): Button | undefined
    {
        return this.cells.get(SecurityModelView.CellKey(concept, action))
    }

    // Test seam: the live grant checkbox for (field label, permission).
    public GrantBox(label: string, permission: FieldPermission): Checkbox | undefined
    {
        return this.grants.get(SecurityModelView.CellKey(label, permission))
    }

    public async Refresh(): Promise<void>
    {
        await this.Act(() => this.vm.LoadEnvironments())
    }

    public Dispose(): void
    {
        for (const subscription of this.subscriptions)
        {
            subscription.dispose()
        }
        this.subscriptions.length = 0
        this.DisposeRowSubscriptions()
        this.cells.clear()
        this.grants.clear()
    }

    public Render(): void
    {
        this.DisposeRowSubscriptions()
        this.Clear(this, this.body, this.rolesPane, this.privilegeHost, this.fieldHost, this.recordHost, this.peopleHost, this.businessUnitHost, this.teamHost, this.membershipHost, this.ownershipHost, this.ruleBody, this.overrideBody)
        const vm = this.vm
        this.message.Text = vm.State === SecurityModelState.Error ? TenantViewBase.NoMessage : vm.Error
        this.AddChild(this.MakeEnvironmentStrip())
        this.AddChild(this.message)
        // A loaded model (Ready OR Empty of roles/profiles) always exposes the Roles / Organization
        // switch and the save bar: org data is editable and saveable even with no roles yet.
        const empty = vm.State === SecurityModelState.Empty
        const loaded = vm.State === SecurityModelState.Ready || empty
        if (loaded)
        {
            this.BuildBody()
        }
        this.stateHost.Update(this.HostInputs())
        this.AddChild(this.stateHost)
        if (empty)
        {
            this.AddChild(this.body)
        }
        if (loaded)
        {
            this.AddChild(this.saveBar)
        }
        this.UpdateSaveBar()
    }

    private HostInputs(): ScreenHostInputs
    {
        const state = this.vm.State
        return {
            loading: state === SecurityModelState.Loading,
            allowed: state !== SecurityModelState.Forbidden,
            isEmpty: state === SecurityModelState.Empty || state === SecurityModelState.NoEnvironment,
            error: state === SecurityModelState.Error,
            empty: { title: state === SecurityModelState.NoEnvironment ? SecurityModelView.NoEnvironmentTitle : SecurityModelView.EmptyTitle },
            errorConfig: { title: SecurityModelView.ErrorTitle, body: this.vm.Error },
            denied: { what: SecurityModelView.DeniedWhat, need: SecurityModelView.DeniedNeed, who: this.Navigator?.OwnerContact },
            content: this.body,
        }
    }

    private Clear(...panels: StackPanel[]): void
    {
        for (const panel of panels)
        {
            for (const child of [...panel.Children])
            {
                panel.RemoveChild(child)
            }
        }
    }

    private BuildBody(): void
    {
        this.cells.clear()
        this.grants.clear()
        this.BuildPrivilegeHost()
        this.BuildFieldHost()
        this.BuildRecordHost()
        this.BuildPeopleHost()
        this.BuildBusinessUnitHost()
        this.BuildTeamHost()
        this.BuildMembershipHost()
        this.BuildOwnershipHost()
        this.rolesPane.AddChild(this.MakeRoleStrip())
        this.rolesPane.AddChild(this.addRoleStrip)
        if (this.vm.State === SecurityModelState.Empty)
        {
            this.rolesPane.AddChild(this.addProfileStrip)
        }
        this.rolesPane.AddChild(this.roleTabs)
        this.body.AddChild(this.mode)
    }

    private DisposeRowSubscriptions(): void
    {
        for (const subscription of this.rowSubscriptions)
        {
            subscription.dispose()
        }
        this.rowSubscriptions.length = 0
    }

    // Read-only derived projection: concept, scope text, and a pill per share/assign grant.
    private BuildRecordHost(): void
    {
        const rows = this.vm.CurrentRecordSharing()
        if (this.vm.SelectedRoleId === undefined || rows.length === 0)
        {
            this.recordHost.AddChild(this.Text(this.vm.SelectedRoleId === undefined ? SecurityModelView.NoRoleSelectedText : SecurityModelView.NoRecordSharingText))
            return
        }
        for (const row of rows)
        {
            const strip = this.Strip()
            strip.AddChild(this.Text(row.concept))
            strip.AddChild(this.Text(row.scopeText))
            if (row.canShare)
            {
                strip.AddChild(this.MakePill(SecurityModelView.CanShareLabel))
            }
            if (row.canAssign)
            {
                strip.AddChild(this.MakePill(SecurityModelView.CanAssignLabel))
            }
            this.recordHost.AddChild(strip)
        }
    }

    // The derived view is read-only (no focused control), so a privilege edit rebuilds only this
    // subtree; the grid under the click is never touched.
    private RebuildRecordHost(): void
    {
        this.Clear(this.recordHost)
        this.BuildRecordHost()
    }

    private MakePill(label: string): StatusPill
    {
        const pill = new StatusPill(PillKind.Allowed)
        pill.LabelOverride = label
        return pill
    }

    private BuildPrivilegeHost(): void
    {
        const host = this.privilegeHost
        if (this.vm.SelectedRoleId === undefined)
        {
            host.AddChild(this.Text(SecurityModelView.NoRoleSelectedText))
            return
        }
        const header = this.Strip()
        header.AddChild(this.Text(SecurityModelView.ConceptHeader))
        for (const action of Actions)
        {
            header.AddChild(this.Text(SecurityModelView.ActionLabels.get(action) ?? action))
        }
        host.AddChild(header)
        for (const row of this.vm.PrivilegeRows)
        {
            host.AddChild(this.MakePrivilegeRow(row))
        }
        host.AddChild(this.addConceptStrip)
        host.AddChild(this.MakeLegend())
    }

    private MakePrivilegeRow(row: PrivilegeRow): StackPanel
    {
        const wrapper = new StackPanel()
        wrapper.Orientation = Orientation.Vertical
        const sentence = this.Text(SecurityModelView.SentenceFor(row))
        const strip = this.Strip()
        strip.AddChild(this.Text(row.Concept))
        for (const action of Actions)
        {
            strip.AddChild(this.MakeCell(row, action, sentence))
        }
        wrapper.AddChild(strip)
        wrapper.AddChild(sentence)
        return wrapper
    }

    // The cell mutates the draft through the row and updates its own label and the row sentence
    // in place; only the save bar restyles, so the grid is never rebuilt under the click.
    private MakeCell(row: PrivilegeRow, action: PrivilegeAction, sentence: TextBlock): Button
    {
        const text = new TextBlock()
        text.Text = SecurityModelView.SymbolOf(row.LevelFor(action))
        const button = new Button()
        button.Content = text
        button.AddClickHandler(() => this.WhenIdle(() =>
        {
            text.Text = SecurityModelView.SymbolOf(row.Cycle(action))
            sentence.Text = SecurityModelView.SentenceFor(row)
            this.vm.RefreshDirty()
            this.RebuildRecordHost()
        }))
        this.cells.set(SecurityModelView.CellKey(row.Concept, action), button)
        return button
    }

    private BuildFieldHost(): void
    {
        const host = this.fieldHost
        host.AddChild(this.MakeProfileStrip())
        if (this.vm.State !== SecurityModelState.Empty)
        {
            host.AddChild(this.addProfileStrip)
        }
        if (this.vm.SelectedProfileId === undefined)
        {
            host.AddChild(this.Text(SecurityModelView.NoProfileSelectedText))
            return
        }
        const header = this.Strip()
        header.AddChild(this.Text(SecurityModelView.FieldHeader))
        for (const permission of FieldPermissions)
        {
            header.AddChild(this.Text(SecurityModelView.PermissionLabels.get(permission) ?? permission))
        }
        host.AddChild(header)
        for (const row of this.vm.FieldRows)
        {
            const strip = this.Strip()
            strip.AddChild(this.Text(row.Label))
            for (const permission of FieldPermissions)
            {
                strip.AddChild(this.MakeGrant(row.Label, permission, row))
            }
            strip.AddChild(this.MakeButton(SecurityModelView.RemoveLabel, () => this.WhenIdle(() => this.vm.RemoveSecuredField(row.Concept, row.Field))))
            host.AddChild(strip)
        }
        host.AddChild(this.addFieldStrip)
        host.AddChild(this.Text(SecurityModelView.WhoHasProfileTitle))
        if (this.vm.ProfileClaimRows.length + this.vm.ProfilePrincipalRows.length + this.vm.ProfileTeamRows.length === 0)
        {
            host.AddChild(this.Text(SecurityModelView.NoOneHasProfileText))
        }
        this.AddAssignmentEditors(host, AssignmentSide.Profile)
    }

    private BuildPeopleHost(): void
    {
        const host = this.peopleHost
        const roleId = this.vm.SelectedRoleId
        if (roleId === undefined)
        {
            host.AddChild(this.Text(SecurityModelView.NoRoleSelectedText))
            return
        }
        const holders = this.vm.RoleHolders
        const claims = holders.byClaim.length
        const teams = holders.byTeam.length
        if (holders.directCount === 0 && claims === 0 && teams === 0)
        {
            host.AddChild(this.Text(SecurityModelView.NoOneAssignedText))
        }
        else
        {
            host.AddChild(this.Text(this.HeadlineFor(holders.directCount, claims, teams)))
        }
        this.AddAssignmentEditors(host, AssignmentSide.Role)
    }

    // Counts only: they change on add/remove (a rebuild), so they never go stale on a claim-text edit.
    private HeadlineFor(direct: number, claims: number, teams: number): string
    {
        let text = direct + SecurityModelView.AssignedDirectlySuffix
        const parts: string[] = []
        if (claims > 0)
        {
            parts.push(claims + (claims === 1 ? SecurityModelView.ClaimRuleOne : SecurityModelView.ClaimRuleMany))
        }
        if (teams > 0)
        {
            parts.push(teams + (teams === 1 ? SecurityModelView.TeamOne : SecurityModelView.TeamMany))
        }
        if (parts.length > 0)
        {
            text += SecurityModelView.AlsoGrantedPrefix + parts.join(SecurityModelView.AndWord)
        }
        return text
    }

    // The three assignment editors (by person / by claim / by team) for the selected role or profile.
    private AddAssignmentEditors(host: StackPanel, side: AssignmentSide): void
    {
        const role = side === AssignmentSide.Role
        const claims = role ? this.vm.RoleClaimRows : this.vm.ProfileClaimRows
        const principals = role ? this.vm.RolePrincipalRows : this.vm.ProfilePrincipalRows
        const teams = role ? this.vm.RoleTeamRows : this.vm.ProfileTeamRows
        host.AddChild(this.Text(SecurityModelView.ByPersonTitle))
        for (const row of principals)
        {
            host.AddChild(this.MakePrincipalRow(row))
        }
        host.AddChild(role ? this.addRolePrincipalStrip : this.addProfilePrincipalStrip)
        host.AddChild(this.Text(SecurityModelView.ByClaimTitle))
        for (const row of claims)
        {
            host.AddChild(this.MakeClaimGrantRow(row))
        }
        host.AddChild(this.MakeButton(SecurityModelView.AddClaimGrantLabel, () => this.WhenIdle(() => this.AddClaimGrant(side))))
        host.AddChild(this.Text(SecurityModelView.ByTeamTitle))
        for (const row of teams)
        {
            host.AddChild(this.MakeTeamGrantRow(row))
        }
        host.AddChild(this.MakeTeamPicker(side, teams))
    }

    private AddClaimGrant(side: AssignmentSide): void
    {
        if (side === AssignmentSide.Role)
        {
            this.vm.AddRoleClaimGrant()
        }
        else
        {
            this.vm.AddProfileClaimGrant()
        }
    }

    private AddPrincipalGrant(side: AssignmentSide, principalId: string): void
    {
        if (side === AssignmentSide.Role)
        {
            this.vm.AddRolePrincipalGrant(principalId)
        }
        else
        {
            this.vm.AddProfilePrincipalGrant(principalId)
        }
    }

    private AddTeamGrant(side: AssignmentSide, teamId: string): void
    {
        if (side === AssignmentSide.Role)
        {
            this.vm.AddRoleTeamGrant(teamId)
        }
        else
        {
            this.vm.AddProfileTeamGrant(teamId)
        }
    }

    private MakePrincipalRow(row: AssignmentPrincipalRow): StackPanel
    {
        const strip = this.Strip()
        strip.AddChild(this.Text(row.PrincipalId))
        strip.AddChild(this.MakeButton(SecurityModelView.RemoveLabel, () => this.WhenIdle(() => row.Remove())))
        return strip
    }

    // The rows are immutable snapshots (rebuilt on Refresh), so each box tracks its own last-applied
    // text; an in-place edit only restyles the save bar and never rebuilds the focused box.
    private MakeClaimGrantRow(row: AssignmentClaimRow): StackPanel
    {
        const strip = this.Strip()
        let claim = row.Claim
        let value = row.Value
        strip.AddChild(this.MakeTextEdit(() => claim, text => { claim = text; row.SetClaim(text) }, SecurityModelView.ClaimPlaceholder))
        strip.AddChild(this.MakeTextEdit(() => value, text => { value = text; row.SetValue(text) }, SecurityModelView.ClaimValuePlaceholder))
        strip.AddChild(this.MakeButton(SecurityModelView.RemoveLabel, () => this.WhenIdle(() => row.Remove())))
        return strip
    }

    private MakeTeamGrantRow(row: AssignmentTeamRow): StackPanel
    {
        const strip = this.Strip()
        strip.AddChild(this.Text(row.TeamName))
        strip.AddChild(this.MakeButton(SecurityModelView.RemoveLabel, () => this.WhenIdle(() => row.Remove())))
        return strip
    }

    // A picker over existing teams not yet granted (never free-text ids); index 0 is the prompt.
    private MakeTeamPicker(side: AssignmentSide, granted: readonly AssignmentTeamRow[]): StackPanel
    {
        const strip = this.Strip()
        const taken = new Set<string>(granted.map(g => g.TeamId))
        const teams = this.vm.TeamRows.filter(t => !taken.has(t.Id))
        const box = new ComboBox()
        box.Items = [SecurityModelView.PickTeamChoice, ...teams.map(t => t.Name)]
        box.SelectedIndex = 0
        strip.AddChild(box)
        strip.AddChild(this.MakeButton(SecurityModelView.AddTeamGrantLabel, () => this.WhenIdle(() =>
        {
            const picked = box.SelectedIndex - 1
            if (picked >= 0 && picked < teams.length)
            {
                this.AddTeamGrant(side, teams[picked].Id)
            }
        })))
        return strip
    }

    // A pointer click flips IsChecked before the handler runs, so the handler reads the new value.
    // While busy the edit is refused and the checkbox snaps back to the draft's value.
    private MakeGrant(label: string, permission: FieldPermission, row: FieldGrantRow): Checkbox
    {
        const cb = new Checkbox()
        cb.IsChecked = row.IsGranted(permission)
        cb.AddClickHandler(() =>
        {
            if (this.vm.Busy)
            {
                cb.IsChecked = row.IsGranted(permission)
                return
            }
            row.Toggle(permission, cb.IsChecked)
            this.vm.RefreshDirty()
        })
        this.grants.set(SecurityModelView.CellKey(label, permission), cb)
        return cb
    }

    // Every draft-mutating click is a no-op while a load or save is in flight, so an edit
    // cannot land after Save snapshotted the draft and then be lost on rebase.
    private WhenIdle(action: () => void): void
    {
        if (!this.vm.Busy)
        {
            action()
        }
    }

    // Runs a view-model call; failures surface through ShowError (401 drops to login).
    private async Act(action: () => Promise<unknown>): Promise<void>
    {
        try
        {
            await action()
        }
        catch (e)
        {
            this.ShowError(e)
        }
    }

    private MakeEnvironmentStrip(): StackPanel
    {
        const strip = this.Strip()
        for (const name of this.vm.Environments)
        {
            const label = name === this.vm.SelectedEnvironment ? SecurityModelView.SelectedMark + name : name
            strip.AddChild(this.MakeButton(label, () => { void this.Act(() => this.vm.SelectEnvironment(name)) }))
        }
        return strip
    }

    private MakeRoleStrip(): StackPanel
    {
        const strip = this.Strip()
        for (const role of this.vm.Roles)
        {
            const label = role.id === this.vm.SelectedRoleId ? SecurityModelView.SelectedMark + role.name : role.name
            strip.AddChild(this.MakeButton(label, () => this.WhenIdle(() => this.vm.SelectRole(role.id))))
            strip.AddChild(this.Text(SecurityModelView.DirectSeparator + this.vm.DirectHolderCountFor(role.id) + SecurityModelView.DirectSuffix))
        }
        const selected = this.vm.SelectedRoleId
        if (selected !== undefined)
        {
            strip.AddChild(this.MakeButton(SecurityModelView.DeleteRoleLabel, () => this.WhenIdle(() => this.vm.DeleteRole(selected))))
        }
        return strip
    }

    private MakeProfileStrip(): StackPanel
    {
        const strip = this.Strip()
        for (const profile of this.vm.Profiles)
        {
            const label = profile.id === this.vm.SelectedProfileId ? SecurityModelView.SelectedMark + profile.name : profile.name
            strip.AddChild(this.MakeButton(label, () => this.WhenIdle(() => this.vm.SelectProfile(profile.id))))
        }
        const selected = this.vm.SelectedProfileId
        if (selected !== undefined)
        {
            strip.AddChild(this.MakeButton(SecurityModelView.DeleteProfileLabel, () => this.WhenIdle(() => this.vm.DeleteProfile(selected))))
        }
        return strip
    }

    // The text boxes are stateful, so their strips are built once and re-attached on each Render.
    private BuildAddStrips(): void
    {
        this.addRoleStrip.Orientation = Orientation.Horizontal
        this.addRoleStrip.AddChild(this.roleBox)
        this.addRoleStrip.AddChild(this.MakeButton(SecurityModelView.AddRoleLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.vm.AddRole(this.roleBox.Text)
                this.roleBox.Text = TenantViewBase.NoMessage
            })
        }))
        this.addConceptStrip.Orientation = Orientation.Horizontal
        this.addConceptStrip.AddChild(this.conceptBox)
        this.addConceptStrip.AddChild(this.MakeButton(SecurityModelView.AddConceptLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.vm.AddConcept(this.conceptBox.Text)
                this.conceptBox.Text = TenantViewBase.NoMessage
            })
        }))
        this.addProfileStrip.Orientation = Orientation.Horizontal
        this.addProfileStrip.AddChild(this.profileBox)
        this.addProfileStrip.AddChild(this.MakeButton(SecurityModelView.AddProfileLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.vm.AddProfile(this.profileBox.Text)
                this.profileBox.Text = TenantViewBase.NoMessage
            })
        }))
        this.addRolePrincipalBox.Placeholder = SecurityModelView.AssignmentPrincipalPlaceholder
        this.addProfilePrincipalBox.Placeholder = SecurityModelView.AssignmentPrincipalPlaceholder
        this.addRolePrincipalStrip.Orientation = Orientation.Horizontal
        this.addRolePrincipalStrip.AddChild(this.addRolePrincipalBox)
        this.addRolePrincipalStrip.AddChild(this.MakeButton(SecurityModelView.AddPersonLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.AddPrincipalGrant(AssignmentSide.Role, this.addRolePrincipalBox.Text)
                this.addRolePrincipalBox.Text = TenantViewBase.NoMessage
            })
        }))
        this.addProfilePrincipalStrip.Orientation = Orientation.Horizontal
        this.addProfilePrincipalStrip.AddChild(this.addProfilePrincipalBox)
        this.addProfilePrincipalStrip.AddChild(this.MakeButton(SecurityModelView.AddPersonLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.AddPrincipalGrant(AssignmentSide.Profile, this.addProfilePrincipalBox.Text)
                this.addProfilePrincipalBox.Text = TenantViewBase.NoMessage
            })
        }))
        this.addFieldStrip.Orientation = Orientation.Horizontal
        this.addFieldStrip.AddChild(this.fieldConceptBox)
        this.addFieldStrip.AddChild(this.fieldBox)
        this.addFieldStrip.AddChild(this.MakeButton(SecurityModelView.AddSecuredFieldLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.vm.AddSecuredField(this.fieldConceptBox.Text, this.fieldBox.Text)
                this.fieldConceptBox.Text = TenantViewBase.NoMessage
                this.fieldBox.Text = TenantViewBase.NoMessage
            })
        }))
    }

    private MakeLegend(): StackPanel
    {
        const legend = new StackPanel()
        legend.AddChild(this.Text(SecurityModelView.LegendHeading))
        for (const level of LevelCycle)
        {
            const name = SecurityModelView.LevelNames.get(level) ?? level
            legend.AddChild(this.Text(SecurityModelView.SymbolOf(level) + SecurityModelView.LegendSeparator + name))
        }
        return legend
    }

    // The one save bar: built once, restyled in place (text + enabled) as Dirty/Busy change.
    private BuildSaveBar(): void
    {
        this.saveBar.Orientation = Orientation.Horizontal
        this.saveBar.AddChild(this.saveText)
        this.saveBar.AddChild(this.discardButton)
        this.saveBar.AddChild(this.saveButton)
    }

    private UpdateSaveBar(): void
    {
        const editable = this.vm.Dirty && !this.vm.Busy
        this.saveText.Text = this.vm.Dirty ? SecurityModelView.UnsavedText : SecurityModelView.NoChangesText
        this.saveButton.IsEnabled = editable
        this.discardButton.IsEnabled = editable
    }

    // ---- Organization sub-editors ----

    private BuildBusinessUnitHost(): void
    {
        const host = this.businessUnitHost
        const rows = this.vm.BusinessUnitRows
        if (rows.length === 0)
        {
            host.AddChild(this.Text(SecurityModelView.NoBusinessUnitsText))
        }
        const labels = this.UnitLabels()
        const byId = new Map<string, BusinessUnitRow>(rows.map(r => [r.Id, r]))
        const children = this.ChildMap(rows)
        for (const row of rows)
        {
            const strip = this.Strip()
            const indent = this.Text(this.IndentFor(row, byId))
            strip.AddChild(indent)
            strip.AddChild(this.MakeTextEdit(() => row.Name, text => row.Rename(text), SecurityModelView.BusinessUnitPlaceholder))
            const excluded = this.DescendantsOf(row.Id, children)
            const others = rows.filter(r => r.Id !== row.Id && !excluded.has(r.Id)).map(r => r.Id)
            strip.AddChild(this.MakeUnitChoice(labels, others, () => row.Parent, id =>
            {
                row.SetParent(id)
                indent.Text = this.IndentFor(row, byId)
            }))
            strip.AddChild(this.MakeButton(SecurityModelView.RemoveLabel, () => this.WhenIdle(() => row.Remove())))
            host.AddChild(strip)
        }
        host.AddChild(this.addBusinessUnitStrip)
    }

    private BuildTeamHost(): void
    {
        const host = this.teamHost
        const rows = this.vm.TeamRows
        if (rows.length === 0)
        {
            host.AddChild(this.Text(SecurityModelView.NoTeamsText))
        }
        const labels = this.UnitLabels()
        const unitIds = this.vm.BusinessUnitRows.map(u => u.Id)
        for (const row of rows)
        {
            const strip = this.Strip()
            strip.AddChild(this.MakeTextEdit(() => row.Name, text => row.Rename(text), SecurityModelView.TeamPlaceholder))
            strip.AddChild(this.MakeUnitChoice(labels, unitIds, () => row.OwningBusinessUnit, id => row.SetOwningBusinessUnit(id)))
            strip.AddChild(this.MakeButton(SecurityModelView.RemoveLabel, () => this.WhenIdle(() => row.Remove())))
            host.AddChild(strip)
        }
        host.AddChild(this.addTeamStrip)
    }

    private BuildMembershipHost(): void
    {
        const labels = this.UnitLabels()
        const unitIds = this.vm.BusinessUnitRows.map(u => u.Id)
        const rules = this.vm.MembershipRuleRows
        const ruleBody = this.ruleBody
        if (rules.length === 0)
        {
            ruleBody.AddChild(this.Text(SecurityModelView.NoMembershipRulesText))
        }
        for (const row of rules)
        {
            ruleBody.AddChild(this.MakeRuleRow(row, labels, unitIds))
        }
        ruleBody.AddChild(this.addMembershipRuleStrip)
        const overrides = this.vm.MembershipOverrideRows
        const overrideBody = this.overrideBody
        if (overrides.length === 0)
        {
            overrideBody.AddChild(this.Text(SecurityModelView.NoMembershipOverridesText))
        }
        for (const row of overrides)
        {
            overrideBody.AddChild(this.MakeOverrideRow(row, labels, unitIds))
        }
        overrideBody.AddChild(this.addMembershipOverrideStrip)
        this.membershipHost.AddChild(this.ruleSection)
        this.membershipHost.AddChild(this.overrideSection)
    }

    private MakeRuleRow(row: MembershipRuleRow, labels: ReadonlyMap<string, string>, unitIds: readonly string[]): StackPanel
    {
        const strip = this.Strip()
        strip.AddChild(this.MakeTextEdit(() => row.Claim, text => row.SetClaim(text), SecurityModelView.ClaimPlaceholder))
        strip.AddChild(this.MakeTextEdit(() => row.Value, text => row.SetValue(text), SecurityModelView.ClaimValuePlaceholder))
        strip.AddChild(this.MakeUnitChoice(labels, unitIds, () => row.HomeBusinessUnit, id => row.SetHomeBusinessUnit(id)))
        for (const team of this.vm.TeamRows)
        {
            strip.AddChild(this.MakeTeamToggle(team, () => row.Teams, id => row.ToggleTeam(id)))
        }
        strip.AddChild(this.MakeButton(SecurityModelView.RemoveLabel, () => this.WhenIdle(() => row.Remove())))
        return strip
    }

    private MakeOverrideRow(row: MembershipOverrideRow, labels: ReadonlyMap<string, string>, unitIds: readonly string[]): StackPanel
    {
        const strip = this.Strip()
        strip.AddChild(this.MakeTextEdit(() => row.PrincipalId, text => row.SetPrincipal(text), SecurityModelView.PrincipalPlaceholder))
        strip.AddChild(this.MakeUnitChoice(labels, unitIds, () => row.HomeBusinessUnit, id => row.SetHomeBusinessUnit(id)))
        for (const team of this.vm.TeamRows)
        {
            strip.AddChild(this.MakeTeamToggle(team, () => row.Teams, id => row.ToggleTeam(id)))
        }
        strip.AddChild(this.MakeButton(SecurityModelView.RemoveLabel, () => this.WhenIdle(() => row.Remove())))
        return strip
    }

    private BuildOwnershipHost(): void
    {
        const host = this.ownershipHost
        const rows = this.vm.OwnershipRuleRows
        if (rows.length === 0)
        {
            host.AddChild(this.Text(SecurityModelView.NoOwnershipRulesText))
        }
        for (const row of rows)
        {
            host.AddChild(this.MakeOwnershipRow(row))
        }
        host.AddChild(this.addOwnershipStrip)
    }

    private MakeOwnershipRow(row: OwnershipRuleRow): StackPanel
    {
        const strip = this.Strip()
        strip.AddChild(this.Text(row.Concept))
        strip.AddChild(this.MakeTextEdit(() => row.OwningKind, text => row.SetOwningKind(text), SecurityModelView.OwningKindPlaceholder))
        strip.AddChild(this.MakeTextEdit(() => row.OwningValue, text => row.SetOwningValue(text), SecurityModelView.OwningValuePlaceholder))
        strip.AddChild(this.MakeTextEdit(() => row.OwnerKind, text => row.SetOwnerKind(text), SecurityModelView.OwnerKindPlaceholder))
        strip.AddChild(this.MakeTextEdit(() => row.OwnerValue, text => row.SetOwnerValue(text), SecurityModelView.OwnerValuePlaceholder))
        strip.AddChild(this.MakeButton(SecurityModelView.RemoveLabel, () => this.WhenIdle(() => row.Remove())))
        return strip
    }

    // A text edit applies in place (draft mutated through the row, save bar restyled); it never
    // triggers a rebuild, so the box keeps focus while typing. Ignored while busy.
    private MakeTextEdit(read: () => string, apply: (text: string) => void, placeholder: string): TextBox
    {
        const box = new TextBox()
        box.Placeholder = placeholder
        box.Text = read()
        this.rowSubscriptions.push(box.PropertyChanged(TextBox.TextKey).subscribe(() =>
        {
            if (this.vm.Busy)
            {
                box.Text = read()
                return
            }
            if (box.Text !== read())
            {
                apply(box.Text)
            }
        }))
        return box
    }

    // Choices = "(none)" plus the given unit ids; a pick applies in place, then the box snaps to
    // the draft's truth (a refused pick, e.g. a cycle, shows the unchanged value).
    private MakeUnitChoice(labels: ReadonlyMap<string, string>, ids: readonly string[], read: () => string | undefined, apply: (id: string | undefined) => void): ComboBox
    {
        const none = SecurityModelView.NoneChoice
        const items = [none, ...ids.map(id => labels.get(id) ?? id)]
        const box = new ComboBox()
        box.Items = items
        const indexOf = (id: string | undefined): number => id === undefined ? 0 : ids.indexOf(id) + 1
        box.SelectedIndex = indexOf(read())
        let syncing = false
        const snap = (): void =>
        {
            syncing = true
            box.SelectedIndex = indexOf(read())
            syncing = false
        }
        box.AddSelectionChangedListener(() =>
        {
            if (syncing)
            {
                return
            }
            const picked = box.SelectedIndex - 1
            if (this.vm.Busy)
            {
                snap()
                return
            }
            if (picked !== indexOf(read()) - 1)
            {
                apply(picked < 0 ? undefined : ids[picked])
            }
            snap()
        })
        return box
    }

    private MakeTeamToggle(team: TeamRow, read: () => readonly string[], toggle: (teamId: string) => void): StackPanel
    {
        const strip = this.Strip()
        const cb = new Checkbox()
        cb.IsChecked = read().includes(team.Id)
        cb.AddClickHandler(() =>
        {
            if (!this.vm.Busy)
            {
                toggle(team.Id)
            }
            cb.IsChecked = read().includes(team.Id)
        })
        strip.AddChild(cb)
        strip.AddChild(this.Text(team.Name))
        return strip
    }

    // id -> display label; duplicate names get their id appended so the choices stay distinct.
    private UnitLabels(): ReadonlyMap<string, string>
    {
        const rows = this.vm.BusinessUnitRows
        const counts = new Map<string, number>()
        for (const r of rows)
        {
            counts.set(r.Name, (counts.get(r.Name) ?? 0) + 1)
        }
        const labels = new Map<string, string>()
        for (const r of rows)
        {
            const dup = (counts.get(r.Name) ?? 0) > 1
            labels.set(r.Id, dup ? r.Name + SecurityModelView.IdOpen + r.Id + SecurityModelView.IdClose : r.Name)
        }
        return labels
    }

    private ChildMap(rows: readonly BusinessUnitRow[]): ReadonlyMap<string, readonly string[]>
    {
        const children = new Map<string, string[]>()
        for (const r of rows)
        {
            if (r.Parent !== undefined)
            {
                children.set(r.Parent, [...(children.get(r.Parent) ?? []), r.Id])
            }
        }
        return children
    }

    // Every unit below id (a cycle-safe walk); these cannot be offered as id's parent.
    private DescendantsOf(id: string, children: ReadonlyMap<string, readonly string[]>): ReadonlySet<string>
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

    // Indent by depth along the Parent chain (bounded, so a bad cycle cannot loop).
    private IndentFor(row: BusinessUnitRow, byId: ReadonlyMap<string, BusinessUnitRow>): string
    {
        let depth = 0
        let parent = row.Parent
        while (parent !== undefined && byId.has(parent) && depth < SecurityModelView.MaxDepth)
        {
            depth++
            parent = byId.get(parent)?.Parent
        }
        return SecurityModelView.IndentUnit.repeat(depth)
    }

    // Long-lived add strips (their boxes are stateful), re-attached on each Render.
    private BuildOrgAddStrips(): void
    {
        this.addBusinessUnitStrip.Orientation = Orientation.Horizontal
        this.addBusinessUnitStrip.AddChild(this.businessUnitBox)
        this.addBusinessUnitStrip.AddChild(this.MakeButton(SecurityModelView.AddBusinessUnitLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.vm.AddBusinessUnit(this.businessUnitBox.Text)
                this.businessUnitBox.Text = TenantViewBase.NoMessage
            })
        }))
        this.addTeamStrip.Orientation = Orientation.Horizontal
        this.addTeamStrip.AddChild(this.teamBox)
        this.addTeamStrip.AddChild(this.MakeButton(SecurityModelView.AddTeamLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.vm.AddTeam(this.teamBox.Text)
                this.teamBox.Text = TenantViewBase.NoMessage
            })
        }))
        this.addMembershipRuleStrip.Orientation = Orientation.Horizontal
        this.addMembershipRuleStrip.AddChild(this.MakeButton(SecurityModelView.AddMembershipRuleLabel, () => this.WhenIdle(() => this.vm.AddMembershipRule())))
        this.addMembershipOverrideStrip.Orientation = Orientation.Horizontal
        this.addMembershipOverrideStrip.AddChild(this.MakeButton(SecurityModelView.AddMembershipOverrideLabel, () => this.WhenIdle(() => this.vm.AddMembershipOverride())))
        this.addOwnershipStrip.Orientation = Orientation.Horizontal
        this.addOwnershipStrip.AddChild(this.ownershipBox)
        this.addOwnershipStrip.AddChild(this.MakeButton(SecurityModelView.AddOwnershipRuleLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.vm.AddOwnershipRule(this.ownershipBox.Text)
                this.ownershipBox.Text = TenantViewBase.NoMessage
            })
        }))
    }

    private Strip(): StackPanel
    {
        const strip = new StackPanel()
        strip.Orientation = Orientation.Horizontal
        return strip
    }

    private Text(text: string): TextBlock
    {
        const t = new TextBlock()
        t.Text = text
        return t
    }
}
