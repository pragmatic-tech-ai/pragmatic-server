import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { DataTemplate } from '@pragmatic-tech-ai/mural/basic/templates/data-template.js'
import { GridLength, GridUnitType } from '@pragmatic-tech-ai/mural/basic/panels/grid.js'
import { Checkbox } from '@pragmatic-tech-ai/mural/framework/toggles/checkbox.js'
import { DataGrid } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js'
import { DataGridTemplateColumn, DataGridTextColumn } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js'
import { FieldGrantRow } from './field-grant-row.js'
import { FieldSecurityState, FieldSecurityViewModel } from './field-security-view-model.js'
import type { IRolesPrivilegesSource } from './roles-privileges-view-model.js'
import { FieldPermission, FieldPermissions } from './security-model-draft.js'
import { TenantViewBase } from './tenant-view-base.js'

// Tenant admin "Field security": profile picker plus a secured-field x permission matrix
// whose cells are checkboxes toggled in place.
export class FieldSecurityView extends TenantViewBase
{
    public static readonly FieldHeader = 'Field'
    public static readonly LabelPath = 'Label'
    public static readonly SelectedMark = '● '
    public static readonly LoadingText = 'Loading field security...'
    public static readonly EmptyText = 'No field profiles yet. Add a profile to start.'
    public static readonly NoEnvironmentText = 'No environments available.'
    public static readonly PermissionDeniedText = 'You do not have permission to manage field security.'
    public static readonly BusyText = 'Working...'
    public static readonly DirtyText = 'Unsaved changes'
    public static readonly SaveLabel = 'Save'
    public static readonly RevertLabel = 'Revert'
    public static readonly AddProfileLabel = 'Add profile'
    public static readonly DeleteProfileLabel = 'Delete profile'
    public static readonly AddSecuredFieldLabel = 'Add secured field'
    public static readonly RemoveSecuredFieldLabel = 'Remove secured field'
    public static readonly ProfilePlaceholder = 'New profile name'
    public static readonly ConceptPlaceholder = 'Concept'
    public static readonly FieldPlaceholder = 'Field'

    public static readonly ReadLabel = 'Read'
    public static readonly UpdateLabel = 'Update'
    public static readonly CreateLabel = 'Create'

    public static readonly PermissionLabels: ReadonlyMap<FieldPermission, string> = new Map<FieldPermission, string>([
        [FieldPermission.Read, FieldSecurityView.ReadLabel],
        [FieldPermission.Update, FieldSecurityView.UpdateLabel],
        [FieldPermission.Create, FieldSecurityView.CreateLabel],
    ])

    private readonly vm: FieldSecurityViewModel
    private readonly grid = new DataGrid()
    private readonly profileBox = new TextBox()
    private readonly conceptBox = new TextBox()
    private readonly fieldBox = new TextBox()
    private readonly addProfileStrip = new StackPanel()
    private readonly addFieldStrip = new StackPanel()

    public constructor(source: IRolesPrivilegesSource)
    {
        super()
        this.vm = new FieldSecurityViewModel(source)
        this.profileBox.Placeholder = FieldSecurityView.ProfilePlaceholder
        this.conceptBox.Placeholder = FieldSecurityView.ConceptPlaceholder
        this.fieldBox.Placeholder = FieldSecurityView.FieldPlaceholder
        this.BuildGrid()
        this.BuildAddStrips()
        const rerender = (): void => this.Render()
        this.vm.PropertyChanged(FieldSecurityViewModel.RowsProperty).subscribe(() =>
        {
            this.UpdateGrid()
            this.Render()
        })
        this.vm.PropertyChanged(FieldSecurityViewModel.EnvironmentsProperty).subscribe(rerender)
        this.vm.PropertyChanged(FieldSecurityViewModel.SelectedEnvironmentProperty).subscribe(rerender)
        this.vm.PropertyChanged(FieldSecurityViewModel.ProfilesProperty).subscribe(rerender)
        this.vm.PropertyChanged(FieldSecurityViewModel.SelectedProfileIdProperty).subscribe(rerender)
        this.vm.PropertyChanged(FieldSecurityViewModel.BusyProperty).subscribe(rerender)
        this.vm.PropertyChanged(FieldSecurityViewModel.StateProperty).subscribe(rerender)
        this.vm.PropertyChanged(FieldSecurityViewModel.ErrorProperty).subscribe(rerender)
        this.vm.PropertyChanged(FieldSecurityViewModel.DirtyProperty).subscribe(rerender)
        this.Render()
    }

    // Test seam: the field-grant matrix.
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
            case FieldSecurityState.Loading:
                this.AddChild(this.Text(FieldSecurityView.LoadingText))
                return
            case FieldSecurityState.NoEnvironment:
                this.AddChild(this.Text(FieldSecurityView.NoEnvironmentText))
                return
            case FieldSecurityState.Forbidden:
                this.AddChild(this.Text(FieldSecurityView.PermissionDeniedText))
                return
            case FieldSecurityState.Error:
                return
            case FieldSecurityState.Empty:
                this.AddChild(this.Text(FieldSecurityView.EmptyText))
                this.AddChild(this.addProfileStrip)
                return
            case FieldSecurityState.Ready:
                break
        }
        this.AddChild(this.MakeProfileStrip())
        this.AddChild(this.addProfileStrip)
        this.AddChild(this.grid)
        this.AddChild(this.addFieldStrip)
        this.AddChild(this.MakeSaveStrip())
    }

    private BuildGrid(): void
    {
        const field = new DataGridTextColumn()
        field.Header = FieldSecurityView.FieldHeader
        field.BindingPath = FieldSecurityView.LabelPath
        field.Width = new GridLength(3, GridUnitType.Star)
        this.grid.Columns.Add(field)
        for (const permission of FieldPermissions)
        {
            const col = new DataGridTemplateColumn()
            col.Header = FieldSecurityView.PermissionLabels.get(permission) ?? permission
            col.Width = GridLength.Auto
            col.CellTemplate = new DataTemplate(data => this.MakeCell(data as FieldGrantRow, permission))
            this.grid.Columns.Add(col)
        }
    }

    // A pointer click flips IsChecked before the handler runs, so the handler reads the new value.
    // While busy the edit is refused and the checkbox snaps back to the draft's value.
    private MakeCell(row: FieldGrantRow, permission: FieldPermission): Checkbox
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
            const label = name === this.vm.SelectedEnvironment ? FieldSecurityView.SelectedMark + name : name
            strip.AddChild(this.MakeButton(label, () => { void this.Act(() => this.vm.SelectEnvironment(name)) }))
        }
        return strip
    }

    private MakeProfileStrip(): StackPanel
    {
        const strip = this.Strip()
        for (const profile of this.vm.Profiles)
        {
            const label = profile.id === this.vm.SelectedProfileId ? FieldSecurityView.SelectedMark + profile.name : profile.name
            strip.AddChild(this.MakeButton(label, () => this.WhenIdle(() => this.vm.SelectProfile(profile.id))))
        }
        const selected = this.vm.SelectedProfileId
        if (selected !== undefined)
        {
            strip.AddChild(this.MakeButton(FieldSecurityView.DeleteProfileLabel, () => this.WhenIdle(() => this.vm.DeleteProfile(selected))))
        }
        return strip
    }

    // The text boxes are stateful, so their strips are built once and re-attached on each Render.
    private BuildAddStrips(): void
    {
        this.addProfileStrip.Orientation = Orientation.Horizontal
        this.addProfileStrip.AddChild(this.profileBox)
        this.addProfileStrip.AddChild(this.MakeButton(FieldSecurityView.AddProfileLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.vm.AddProfile(this.profileBox.Text)
                this.profileBox.Text = TenantViewBase.NoMessage
            })
        }))
        this.addFieldStrip.Orientation = Orientation.Horizontal
        this.addFieldStrip.AddChild(this.conceptBox)
        this.addFieldStrip.AddChild(this.fieldBox)
        this.addFieldStrip.AddChild(this.MakeButton(FieldSecurityView.AddSecuredFieldLabel, () =>
        {
            this.WhenIdle(() =>
            {
                this.vm.AddSecuredField(this.conceptBox.Text, this.fieldBox.Text)
                this.conceptBox.Text = TenantViewBase.NoMessage
                this.fieldBox.Text = TenantViewBase.NoMessage
            })
        }))
        this.addFieldStrip.AddChild(this.MakeButton(FieldSecurityView.RemoveSecuredFieldLabel, () =>
        {
            this.WhenIdle(() =>
            {
                const selected = this.grid.SelectedItem
                if (selected instanceof FieldGrantRow)
                {
                    this.vm.RemoveSecuredField(selected.Concept, selected.Field)
                }
            })
        }))
    }

    // While a load or save is in flight editing is disabled: Save/Revert are replaced by a busy note.
    private MakeSaveStrip(): StackPanel
    {
        const strip = this.Strip()
        if (this.vm.Busy)
        {
            strip.AddChild(this.Text(FieldSecurityView.BusyText))
            return strip
        }
        strip.AddChild(this.MakeButton(FieldSecurityView.SaveLabel, () => { void this.Act(() => this.vm.Save()) }))
        strip.AddChild(this.MakeButton(FieldSecurityView.RevertLabel, () => { void this.Act(() => this.vm.Revert()) }))
        if (this.vm.Dirty)
        {
            strip.AddChild(this.Text(FieldSecurityView.DirtyText))
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
