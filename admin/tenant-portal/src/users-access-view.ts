import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { GridLength, GridUnitType } from '@pragmatic-tech-ai/mural/basic/panels/grid.js'
import { DataGrid } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js'
import { DataGridTextColumn } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js'
import { SelectionMode } from '@pragmatic-tech-ai/mural/framework/list/selector.js'
import type { AccountRow } from './account-row.js'
import { TenantRole } from './tenant-types.js'
import type { GrantDto, IUsersAccessSource } from './tenant-types.js'
import { TenantViewBase } from './tenant-view-base.js'
import { PendingKind, UsersAccessState, UsersAccessViewModel } from './users-access-view-model.js'

// Tenant admin "Users & Access": environment picker, accounts DataGrid, create-account form,
// and a selected-account section (disable, grants, grant/revoke role).
export class UsersAccessView extends TenantViewBase
{
    public static readonly EmailHeader = 'Email'
    public static readonly PrincipalHeader = 'Principal'
    public static readonly StatusHeader = 'Status'
    public static readonly RolesHeader = 'Roles'
    public static readonly EmailPath = 'Email'
    public static readonly PrincipalPath = 'PrincipalId'
    public static readonly StatusPath = 'Status'
    public static readonly RolesPath = 'RolesText'
    public static readonly SelectedMark = '● '
    public static readonly LoadingText = 'Loading accounts...'
    public static readonly EmptyText = 'No accounts yet.'
    public static readonly NoEnvironmentText = 'No environments available.'
    public static readonly EmailPlaceholder = 'Email'
    public static readonly PrincipalPlaceholder = 'Principal id'
    public static readonly PasswordPlaceholder = 'Password'
    public static readonly CreateLabel = 'Create'
    public static readonly CreateHeading = 'Create account'
    public static readonly SelectedHeading = 'Selected account: '
    public static readonly DisableLabel = 'Disable'
    public static readonly ConfirmDisableLabel = 'Confirm disable'
    public static readonly ConfirmRevokeLabel = 'Confirm revoke'
    public static readonly CancelLabel = 'Cancel'
    public static readonly RevokeLabel = 'Revoke'
    public static readonly GrantLabel = 'Grant'
    public static readonly GrantsHeading = 'Grants'
    public static readonly NoGrantsText = 'No grants.'
    public static readonly SelfDisableWarning = 'This is your own account; disabling it will lock you out.'
    public static readonly SelfRevokeWarning = 'This is your own grant; revoking it may reduce your access.'
    public static readonly GrantSeparator = ' '
    public static readonly PathSeparator = '/'

    private static readonly Empty = ''

    private readonly vm: UsersAccessViewModel
    private readonly grid = new DataGrid()
    private readonly emailBox = new TextBox()
    private readonly principalBox = new TextBox()
    private readonly passwordBox = new TextBox()
    private readonly form = new StackPanel()
    private readonly selectionListener = (): void => this.vm.SelectAccount((this.grid.SelectedItem as AccountRow | undefined)?.PrincipalId)

    public constructor(source: IUsersAccessSource, currentPrincipalId: string)
    {
        super()
        this.vm = new UsersAccessViewModel(source, currentPrincipalId)
        this.BuildGrid()
        this.BuildForm()
        const rerender = (): void => this.Render()
        this.vm.PropertyChanged(UsersAccessViewModel.RowsProperty).subscribe(() => this.UpdateGrid())
        this.vm.PropertyChanged(UsersAccessViewModel.EnvironmentsProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.SelectedEnvironmentProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.StateProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.ErrorProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.SelectedPrincipalIdProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.PendingProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.SelectedGrantsProperty).subscribe(rerender)
        this.Render()
    }

    // Test seam: the accounts grid.
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
        this.grid.RemoveSelectionChangedListener(this.selectionListener)
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
            case UsersAccessState.Ready:
                this.AddChild(this.grid)
                break
            case UsersAccessState.Loading:
                this.AddChild(this.Text(UsersAccessView.LoadingText))
                break
            case UsersAccessState.Empty:
                this.AddChild(this.Text(UsersAccessView.EmptyText))
                break
            case UsersAccessState.NoEnvironment:
                this.AddChild(this.Text(UsersAccessView.NoEnvironmentText))
                break
            case UsersAccessState.Error:
                break
        }
        if (vm.SelectedEnvironment !== undefined)
        {
            this.AddChild(this.form)
        }
        if (vm.SelectedPrincipalId !== undefined)
        {
            this.AddChild(this.MakeSelectedSection(vm.SelectedPrincipalId))
        }
    }

    private BuildGrid(): void
    {
        this.AddColumn(UsersAccessView.EmailHeader, UsersAccessView.EmailPath, new GridLength(2, GridUnitType.Star))
        this.AddColumn(UsersAccessView.PrincipalHeader, UsersAccessView.PrincipalPath, new GridLength(2, GridUnitType.Star))
        this.AddColumn(UsersAccessView.StatusHeader, UsersAccessView.StatusPath, GridLength.Auto)
        this.AddColumn(UsersAccessView.RolesHeader, UsersAccessView.RolesPath, new GridLength(3, GridUnitType.Star))
        this.grid.SelectionMode = SelectionMode.Single
        this.grid.AddSelectionChangedListener(this.selectionListener)
    }

    private AddColumn(header: string, path: string, width: GridLength): void
    {
        const col = new DataGridTextColumn()
        col.Header = header
        col.BindingPath = path
        col.Width = width
        this.grid.Columns.Add(col)
    }

    private BuildForm(): void
    {
        this.emailBox.Placeholder = UsersAccessView.EmailPlaceholder
        this.principalBox.Placeholder = UsersAccessView.PrincipalPlaceholder
        this.passwordBox.Placeholder = UsersAccessView.PasswordPlaceholder
        this.passwordBox.IsPassword = true
        this.form.AddChild(this.Text(UsersAccessView.CreateHeading))
        this.form.AddChild(this.emailBox)
        this.form.AddChild(this.principalBox)
        this.form.AddChild(this.passwordBox)
        this.form.AddChild(this.MakeButton(UsersAccessView.CreateLabel, () => { void this.Act(() => this.Create()) }))
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
        const strip = new StackPanel()
        strip.Orientation = Orientation.Horizontal
        for (const name of this.vm.Environments)
        {
            const label = name === this.vm.SelectedEnvironment ? UsersAccessView.SelectedMark + name : name
            strip.AddChild(this.MakeButton(label, () => { void this.Act(() => this.vm.SelectEnvironment(name)) }))
        }
        return strip
    }

    private async Create(): Promise<void>
    {
        const vm = this.vm
        vm.DraftEmail = this.emailBox.Text
        vm.DraftPrincipalId = this.principalBox.Text
        vm.DraftPassword = this.passwordBox.Text
        await vm.CreateAccount()
        if (vm.Error === UsersAccessView.Empty)
        {
            this.emailBox.Text = UsersAccessView.Empty
            this.principalBox.Text = UsersAccessView.Empty
            this.passwordBox.Text = UsersAccessView.Empty
        }
    }

    private MakeSelectedSection(principalId: string): StackPanel
    {
        const vm = this.vm
        const section = new StackPanel()
        section.AddChild(this.Text(UsersAccessView.SelectedHeading + principalId))
        const pending = vm.Pending
        if (pending !== undefined && pending.kind === PendingKind.DisableSelf)
        {
            section.AddChild(this.Text(UsersAccessView.SelfDisableWarning))
            section.AddChild(this.MakeConfirmStrip(UsersAccessView.ConfirmDisableLabel))
        }
        else
        {
            section.AddChild(this.MakeButton(UsersAccessView.DisableLabel, () => vm.RequestDisable(principalId)))
        }
        section.AddChild(this.Text(UsersAccessView.GrantsHeading))
        const grants = vm.SelectedGrants
        if (grants.length === 0)
        {
            section.AddChild(this.Text(UsersAccessView.NoGrantsText))
        }
        for (const grant of grants)
        {
            section.AddChild(this.MakeGrantRow(grant))
        }
        section.AddChild(this.MakeRoleStrip())
        section.AddChild(this.MakeButton(UsersAccessView.GrantLabel, () => { void this.Act(() => vm.GrantRole()) }))
        return section
    }

    private MakeGrantRow(grant: GrantDto): StackPanel
    {
        const vm = this.vm
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        const path = grant.resourcePath.join(UsersAccessView.PathSeparator)
        row.AddChild(this.Text(grant.role + UsersAccessView.GrantSeparator + path))
        const pending = vm.Pending
        const confirming = pending !== undefined && pending.kind === PendingKind.RevokeSelf && pending.role === grant.role && pending.principalId === grant.subject
        if (confirming)
        {
            row.AddChild(this.Text(UsersAccessView.SelfRevokeWarning))
            row.AddChild(this.MakeConfirmStrip(UsersAccessView.ConfirmRevokeLabel))
        }
        else
        {
            row.AddChild(this.MakeButton(UsersAccessView.RevokeLabel, () => vm.RequestRevoke(grant)))
        }
        return row
    }

    private MakeConfirmStrip(confirmLabel: string): StackPanel
    {
        const vm = this.vm
        const strip = new StackPanel()
        strip.Orientation = Orientation.Horizontal
        strip.AddChild(this.MakeButton(confirmLabel, () => { void this.Act(() => vm.ConfirmPending()) }))
        strip.AddChild(this.MakeButton(UsersAccessView.CancelLabel, () => vm.CancelPending()))
        return strip
    }

    private MakeRoleStrip(): StackPanel
    {
        const strip = new StackPanel()
        strip.Orientation = Orientation.Horizontal
        for (const role of Object.values(TenantRole))
        {
            const label = role === this.vm.DraftRole ? UsersAccessView.SelectedMark + role : role
            strip.AddChild(this.MakeButton(label, () => { this.vm.DraftRole = role; this.Render() }))
        }
        return strip
    }

    private Text(text: string): TextBlock
    {
        const t = new TextBlock()
        t.Text = text
        return t
    }
}
