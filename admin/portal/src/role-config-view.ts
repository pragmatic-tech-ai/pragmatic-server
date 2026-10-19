import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ComboBox } from '@pragmatic-tech-ai/mural/framework'
import type { ControlPlaneClient } from './api-client.js'
import type { IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'
import { RoleAccessLevel, RoleAction, RoleConfigViewModel } from './role-config-view-model.js'
import type { RoleConceptRow } from './role-config-view-model.js'

// ComboBox item: Mural's collapsed selection text reads Label.
export class LevelOption
{
    public constructor(public readonly Label: string)
    {
    }
}

// Per-concept role configuration: CRUD access levels per role, plus role assignment to principals.
export class RoleConfigView extends PortalViewBase
{
    private static readonly RolesHeading = 'Roles'
    private static readonly AssignHeading = 'Assign role'
    private static readonly SaveLabel = 'Save'
    private static readonly AddLabel = 'Add concept'
    private static readonly AssignLabel = 'Assign'
    private static readonly RoleIdPlaceholder = 'Role id'
    private static readonly ConceptPlaceholder = 'Concept'
    private static readonly PrincipalPlaceholder = 'Principal id'
    private static readonly LabelPath = 'Label'
    private static readonly RowSeparator = ' / '
    private static readonly Actions: readonly RoleAction[] = [RoleAction.Create, RoleAction.Read, RoleAction.Update, RoleAction.Delete]
    private static readonly Levels: LevelOption[] = Object.values(RoleAccessLevel).map(l => new LevelOption(l))

    private readonly rowsPanel = new StackPanel()
    private readonly roleBox = new TextBox()
    private readonly conceptBox = new TextBox()
    private readonly principalBox = new TextBox()
    private readonly vm: RoleConfigViewModel

    public constructor(client: ControlPlaneClient, private readonly nav: IPortalNavigator, private readonly name: string)
    {
        super()
        this.vm = new RoleConfigViewModel(client, name)
        this.vm.PropertyChanged(RoleConfigViewModel.RowsProperty).subscribe(() => { this.RebuildRows() })
        this.vm.PropertyChanged(RoleConfigViewModel.StatusProperty).subscribe(() => { this.message.Text = this.vm.Status })
        this.AddChild(this.Heading(this.name))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowDetail(this.name) }))
        this.AddChild(this.message)
        this.AddChild(this.Heading(RoleConfigView.RolesHeading))
        this.AddChild(this.rowsPanel)
        this.roleBox.Placeholder = RoleConfigView.RoleIdPlaceholder
        this.conceptBox.Placeholder = RoleConfigView.ConceptPlaceholder
        this.AddChild(this.roleBox)
        this.AddChild(this.conceptBox)
        this.AddChild(this.MakeButton(RoleConfigView.AddLabel, () =>
        {
            const role = this.roleBox.Text.trim()
            this.vm.AddRoleConcept(role, role, this.conceptBox.Text.trim())
        }))
        this.AddChild(this.Heading(RoleConfigView.AssignHeading))
        this.principalBox.Placeholder = RoleConfigView.PrincipalPlaceholder
        this.AddChild(this.principalBox)
        this.AddChild(this.MakeButton(RoleConfigView.AssignLabel, () => { this.vm.AssignRole(this.principalBox.Text.trim(), this.roleBox.Text.trim()) }))
        this.AddChild(this.MakeButton(RoleConfigView.SaveLabel, () => { void this.vm.Save() }))
    }

    public async Refresh(): Promise<void>
    {
        await this.vm.Open()
    }

    private RebuildRows(): void
    {
        for (const child of [...this.rowsPanel.Children])
        {
            this.rowsPanel.RemoveChild(child)
        }
        for (const row of this.vm.Rows)
        {
            this.rowsPanel.AddChild(this.RowPanel(row))
        }
    }

    private RowPanel(row: RoleConceptRow): StackPanel
    {
        const panel = new StackPanel()
        panel.Orientation = Orientation.Horizontal
        panel.AddChild(this.Heading(row.RoleId + RoleConfigView.RowSeparator + row.Concept))
        for (const action of RoleConfigView.Actions)
        {
            const box = new ComboBox()
            box.DisplayMemberPath = RoleConfigView.LabelPath
            box.ItemsSource = RoleConfigView.Levels
            box.SelectedIndex = RoleConfigView.Levels.findIndex(l => l.Label === row.Levels[action])
            panel.AddChild(this.Heading(action))
            panel.AddChild(box)
            box.PropertyChanged(ComboBox.SelectedItemKey).subscribe(() =>
            {
                const picked = box.SelectedItem as LevelOption | undefined
                if (picked !== undefined && picked.Label !== row.Levels[action])
                {
                    this.vm.SetLevel(row.RoleId, row.Concept, action, picked.Label as RoleAccessLevel)
                }
            })
        }
        return panel
    }

    private Heading(text: string): TextBlock
    {
        const heading = new TextBlock()
        heading.Text = text
        return heading
    }
}
