import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Checkbox } from '@pragmatic-tech-ai/mural/framework/toggles/checkbox.js'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ScreenHost } from './kit/screen-host.js'
import type { ScreenHostInputs } from './kit/screen-host.js'
import { Tabs } from './kit/tabs.js'
import type { FieldGrantRow } from './field-grant-row.js'
import type { PrivilegeRow } from './privilege-row.js'
import { AccessLevel, Actions, FieldPermission, FieldPermissions, LevelCycle, PrivilegeAction } from './security-model-draft.js'
import { SecurityModelState, SecurityModelViewModel } from './security-model-view-model.js'
import type { ISecurityModelEnvSource } from './security-model-view-model.js'
import { TenantViewBase } from './tenant-view-base.js'

// Tenant admin security-model editor: a role list over two kit tabs (What they can do = the
// privilege matrix, Fields = the field-security grid) and ONE save bar over the one shared draft.
export class SecurityModelView extends TenantViewBase
{
    public static readonly WhatTheyCanDoLabel = 'What they can do'
    public static readonly FieldsLabel = 'Fields'
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
    private readonly tabs: Tabs
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
        this.tabs = new Tabs({
            entries: [
                { label: SecurityModelView.WhatTheyCanDoLabel, content: this.privilegeHost },
                { label: SecurityModelView.FieldsLabel, content: this.fieldHost },
            ],
        })
        this.stateHost = new ScreenHost({ loading: true, allowed: true, isEmpty: false, error: false })
        this.saveButton = this.MakeButton(SecurityModelView.SaveLabel, () => { void this.Act(() => this.vm.Save()) })
        this.discardButton = this.MakeButton(SecurityModelView.DiscardLabel, () => { void this.Act(() => this.vm.Revert()) })
        this.BuildAddStrips()
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

    public get Tabs(): Tabs
    {
        return this.tabs
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
        this.cells.clear()
        this.grants.clear()
    }

    public Render(): void
    {
        this.Clear(this, this.body, this.privilegeHost, this.fieldHost)
        const vm = this.vm
        this.message.Text = vm.State === SecurityModelState.Error ? TenantViewBase.NoMessage : vm.Error
        this.AddChild(this.MakeEnvironmentStrip())
        this.AddChild(this.message)
        const ready = vm.State === SecurityModelState.Ready
        if (ready)
        {
            this.BuildBody()
        }
        this.stateHost.Update(this.HostInputs())
        this.AddChild(this.stateHost)
        if (vm.State === SecurityModelState.Empty)
        {
            this.AddChild(this.addRoleStrip)
            this.AddChild(this.addProfileStrip)
        }
        if (ready)
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
        this.body.AddChild(this.MakeRoleStrip())
        this.body.AddChild(this.addRoleStrip)
        this.body.AddChild(this.tabs)
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
        }))
        this.cells.set(SecurityModelView.CellKey(row.Concept, action), button)
        return button
    }

    private BuildFieldHost(): void
    {
        const host = this.fieldHost
        host.AddChild(this.MakeProfileStrip())
        host.AddChild(this.addProfileStrip)
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
