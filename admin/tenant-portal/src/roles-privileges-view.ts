import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { DataTemplate } from '@pragmatic-tech-ai/mural/basic/templates/data-template.js'
import { GridLength, GridUnitType } from '@pragmatic-tech-ai/mural/basic/panels/grid.js'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { DataGrid } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js'
import { DataGridTemplateColumn, DataGridTextColumn } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js'
import type { PrivilegeRow } from './privilege-row.js'
import { RolesPrivilegesState, RolesPrivilegesViewModel } from './roles-privileges-view-model.js'
import type { IRolesPrivilegesSource } from './roles-privileges-view-model.js'
import { AccessLevel, Actions, LevelCycle, PrivilegeAction } from './security-model-draft.js'
import { TenantViewBase } from './tenant-view-base.js'

// Tenant admin "Roles & privileges": role picker plus a concept x action matrix whose
// cells cycle through the access levels in place.
export class RolesPrivilegesView extends TenantViewBase
{
    public static readonly ConceptHeader = 'Concept'
    public static readonly ConceptPath = 'Concept'
    public static readonly SelectedMark = '● '
    public static readonly LoadingText = 'Loading roles and privileges...'
    public static readonly EmptyText = 'No roles yet. Add a role to start.'
    public static readonly NoEnvironmentText = 'No environments available.'
    public static readonly PermissionDeniedText = 'You do not have permission to manage roles and privileges.'
    public static readonly BusyText = 'Working...'
    public static readonly DirtyText = 'Unsaved changes'
    public static readonly SaveLabel = 'Save'
    public static readonly RevertLabel = 'Revert'
    public static readonly AddRoleLabel = 'Add role'
    public static readonly DeleteRoleLabel = 'Delete role'
    public static readonly AddConceptLabel = 'Add concept'
    public static readonly RolePlaceholder = 'New role name'
    public static readonly ConceptPlaceholder = 'New concept name'
    public static readonly LegendHeading = 'Access levels'
    public static readonly LegendSeparator = ' = '

    public static readonly NoneSymbol = '○'
    public static readonly UserSymbol = '◔'
    public static readonly BusinessUnitSymbol = '◑'
    public static readonly BusinessUnitAndChildrenSymbol = '◕'
    public static readonly OrganizationSymbol = '●'
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

    public static readonly Symbols: ReadonlyMap<AccessLevel, string> = new Map<AccessLevel, string>([
        [AccessLevel.None, RolesPrivilegesView.NoneSymbol],
        [AccessLevel.User, RolesPrivilegesView.UserSymbol],
        [AccessLevel.BusinessUnit, RolesPrivilegesView.BusinessUnitSymbol],
        [AccessLevel.BusinessUnitAndChildren, RolesPrivilegesView.BusinessUnitAndChildrenSymbol],
        [AccessLevel.Organization, RolesPrivilegesView.OrganizationSymbol],
    ])

    public static readonly LevelNames: ReadonlyMap<AccessLevel, string> = new Map<AccessLevel, string>([
        [AccessLevel.None, RolesPrivilegesView.NoneName],
        [AccessLevel.User, RolesPrivilegesView.UserName],
        [AccessLevel.BusinessUnit, RolesPrivilegesView.BusinessUnitName],
        [AccessLevel.BusinessUnitAndChildren, RolesPrivilegesView.BusinessUnitAndChildrenName],
        [AccessLevel.Organization, RolesPrivilegesView.OrganizationName],
    ])

    public static readonly ActionLabels: ReadonlyMap<PrivilegeAction, string> = new Map<PrivilegeAction, string>([
        [PrivilegeAction.Create, RolesPrivilegesView.CreateLabel],
        [PrivilegeAction.Read, RolesPrivilegesView.ReadLabel],
        [PrivilegeAction.Update, RolesPrivilegesView.UpdateLabel],
        [PrivilegeAction.Delete, RolesPrivilegesView.DeleteLabel],
        [PrivilegeAction.Append, RolesPrivilegesView.AppendLabel],
        [PrivilegeAction.AppendTo, RolesPrivilegesView.AppendToLabel],
        [PrivilegeAction.Assign, RolesPrivilegesView.AssignLabel],
        [PrivilegeAction.Share, RolesPrivilegesView.ShareLabel],
    ])

    private readonly vm: RolesPrivilegesViewModel
    private readonly grid = new DataGrid()
    private readonly roleBox = new TextBox()
    private readonly conceptBox = new TextBox()
    private readonly addRoleStrip = new StackPanel()
    private readonly addConceptStrip = new StackPanel()

    public constructor(source: IRolesPrivilegesSource)
    {
        super()
        this.vm = new RolesPrivilegesViewModel(source)
        this.roleBox.Placeholder = RolesPrivilegesView.RolePlaceholder
        this.conceptBox.Placeholder = RolesPrivilegesView.ConceptPlaceholder
        this.BuildGrid()
        this.BuildAddStrips()
        const rerender = (): void => this.Render()
        this.vm.PropertyChanged(RolesPrivilegesViewModel.RowsProperty).subscribe(() =>
        {
            this.UpdateGrid()
            this.Render()
        })
        this.vm.PropertyChanged(RolesPrivilegesViewModel.EnvironmentsProperty).subscribe(rerender)
        this.vm.PropertyChanged(RolesPrivilegesViewModel.SelectedEnvironmentProperty).subscribe(rerender)
        this.vm.PropertyChanged(RolesPrivilegesViewModel.RolesProperty).subscribe(rerender)
        this.vm.PropertyChanged(RolesPrivilegesViewModel.SelectedRoleIdProperty).subscribe(rerender)
        this.vm.PropertyChanged(RolesPrivilegesViewModel.BusyProperty).subscribe(rerender)
        this.vm.PropertyChanged(RolesPrivilegesViewModel.StateProperty).subscribe(rerender)
        this.vm.PropertyChanged(RolesPrivilegesViewModel.ErrorProperty).subscribe(rerender)
        this.vm.PropertyChanged(RolesPrivilegesViewModel.DirtyProperty).subscribe(rerender)
        this.Render()
    }

    // Test seam: the privilege matrix.
    public get Grid(): DataGrid
    {
        return this.grid
    }

    public async Refresh(): Promise<void>
    {
        await this.Act(() => this.vm.LoadEnvironments())
    }

    public Dispose(): void
    {
        this.grid.dispose()
    }

    public Render(): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
        const vm = this.vm
        this.AddChild(this.MakeEnvironmentStrip())
        this.message.Text = vm.Error
        this.AddChild(this.message)
        switch (vm.State)
        {
            case RolesPrivilegesState.Loading:
                this.AddChild(this.Text(RolesPrivilegesView.LoadingText))
                return
            case RolesPrivilegesState.NoEnvironment:
                this.AddChild(this.Text(RolesPrivilegesView.NoEnvironmentText))
                return
            case RolesPrivilegesState.Forbidden:
                this.AddChild(this.Text(RolesPrivilegesView.PermissionDeniedText))
                return
            case RolesPrivilegesState.Error:
                return
            case RolesPrivilegesState.Empty:
                this.AddChild(this.Text(RolesPrivilegesView.EmptyText))
                this.AddChild(this.addRoleStrip)
                return
            case RolesPrivilegesState.Ready:
                break
        }
        this.AddChild(this.MakeRoleStrip())
        this.AddChild(this.addRoleStrip)
        this.AddChild(this.grid)
        this.AddChild(this.addConceptStrip)
        this.AddChild(this.MakeLegend())
        this.AddChild(this.MakeSaveStrip())
    }

    private BuildGrid(): void
    {
        const concept = new DataGridTextColumn()
        concept.Header = RolesPrivilegesView.ConceptHeader
        concept.BindingPath = RolesPrivilegesView.ConceptPath
        concept.Width = new GridLength(3, GridUnitType.Star)
        this.grid.Columns.Add(concept)
        for (const action of Actions)
        {
            const col = new DataGridTemplateColumn()
            col.Header = RolesPrivilegesView.ActionLabels.get(action) ?? action
            col.Width = GridLength.Auto
            col.CellTemplate = new DataTemplate(data => this.MakeCell(data as PrivilegeRow, action))
            this.grid.Columns.Add(col)
        }
    }

    // The cell mutates the draft through the row and updates its own label in place;
    // the grid is never rebuilt, so only the Dirty indicator re-renders.
    private MakeCell(row: PrivilegeRow, action: PrivilegeAction): Button
    {
        const text = new TextBlock()
        text.Text = RolesPrivilegesView.SymbolOf(row.LevelFor(action))
        const button = new Button()
        button.Content = text
        button.AddClickHandler(() => this.WhenIdle(() =>
        {
            text.Text = RolesPrivilegesView.SymbolOf(row.Cycle(action))
            this.vm.RefreshDirty()
        }))
        return button
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

    private static SymbolOf(level: AccessLevel): string
    {
        return RolesPrivilegesView.Symbols.get(level) ?? RolesPrivilegesView.NoneSymbol
    }

    private UpdateGrid(): void
    {
        this.grid.ItemsSource = [...this.vm.Rows]
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
            const label = name === this.vm.SelectedEnvironment ? RolesPrivilegesView.SelectedMark + name : name
            strip.AddChild(this.MakeButton(label, () => { void this.Act(() => this.vm.SelectEnvironment(name)) }))
        }
        return strip
    }

    private MakeRoleStrip(): StackPanel
    {
        const strip = this.Strip()
        for (const role of this.vm.Roles)
        {
            const label = role.id === this.vm.SelectedRoleId ? RolesPrivilegesView.SelectedMark + role.name : role.name
            strip.AddChild(this.MakeButton(label, () => this.WhenIdle(() => this.vm.SelectRole(role.id))))
        }
        const selected = this.vm.SelectedRoleId
        if (selected !== undefined)
        {
            strip.AddChild(this.MakeButton(RolesPrivilegesView.DeleteRoleLabel, () => this.WhenIdle(() => this.vm.DeleteRole(selected))))
        }
        return strip
    }

    // The text boxes are stateful, so their strips are built once and re-attached on each Render.
    private BuildAddStrips(): void
    {
        this.addRoleStrip.Orientation = Orientation.Horizontal
        this.addRoleStrip.AddChild(this.roleBox)
        this.addRoleStrip.AddChild(this.MakeButton(RolesPrivilegesView.AddRoleLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.vm.AddRole(this.roleBox.Text)
                this.roleBox.Text = TenantViewBase.NoMessage
            })
        }))
        this.addConceptStrip.Orientation = Orientation.Horizontal
        this.addConceptStrip.AddChild(this.conceptBox)
        this.addConceptStrip.AddChild(this.MakeButton(RolesPrivilegesView.AddConceptLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.vm.AddConcept(this.conceptBox.Text)
                this.conceptBox.Text = TenantViewBase.NoMessage
            })
        }))
    }

    private MakeLegend(): StackPanel
    {
        const legend = new StackPanel()
        legend.AddChild(this.Text(RolesPrivilegesView.LegendHeading))
        for (const level of LevelCycle)
        {
            const name = RolesPrivilegesView.LevelNames.get(level) ?? level
            legend.AddChild(this.Text(RolesPrivilegesView.SymbolOf(level) + RolesPrivilegesView.LegendSeparator + name))
        }
        return legend
    }

    // While a load or save is in flight editing is disabled: Save/Revert are replaced by a busy note.
    private MakeSaveStrip(): StackPanel
    {
        const strip = this.Strip()
        if (this.vm.Busy)
        {
            strip.AddChild(this.Text(RolesPrivilegesView.BusyText))
            return strip
        }
        strip.AddChild(this.MakeButton(RolesPrivilegesView.SaveLabel, () => { void this.Act(() => this.vm.Save()) }))
        strip.AddChild(this.MakeButton(RolesPrivilegesView.RevertLabel, () => { void this.Act(() => this.vm.Revert()) }))
        if (this.vm.Dirty)
        {
            strip.AddChild(this.Text(RolesPrivilegesView.DirtyText))
        }
        return strip
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
