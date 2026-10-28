import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import type { AccountRow } from './account-row.js'
import { ConfirmDialog, ConfirmTone, PillKind, StatusPill } from './kit/index.js'
import { TenantRole } from './tenant-types.js'
import type { GrantDto, IUsersAccessSource } from './tenant-types.js'
import { TenantViewBase } from './tenant-view-base.js'
import { PendingKind, UsersAccessState, UsersAccessViewModel } from './users-access-view-model.js'

// Tenant admin "Users & Access": environment picker, accounts row list, create-account form,
// and a selected-account section (disable, grants, grant/revoke role).
export class UsersAccessView extends TenantViewBase
{
    public static readonly SelectedMark = '\u25CF '
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
    public static readonly DisableTitle = 'Disable account'
    public static readonly DisableActionLabel = 'Disable account'
    public static readonly YouTag = 'You'
    public static readonly ConfirmRevokeLabel = 'Confirm revoke'
    public static readonly RevokeLabel = 'Revoke'
    public static readonly GrantLabel = 'Grant'
    public static readonly GrantsHeading = 'Grants'
    public static readonly NoGrantsText = 'No grants.'
    public static readonly SelfDisableWarning = 'This is your own account; disabling it will lock you out.'
    public static readonly SelfRevokeWarning = 'This is your own grant; revoking it may reduce your access.'
    public static readonly GrantSeparator = ' '
    public static readonly PathSeparator = '/'
    public static readonly CancelLabel = 'Cancel'
    public static readonly DisableConsequences: readonly string[] = [
        "They are signed out everywhere and can't sign in.",
        'Their records and history stay. Their tokens stop working.',
    ]

    private readonly vm: UsersAccessViewModel
    private readonly accountList = new StackPanel()
    private readonly rowByPrincipal = new Map<string, StackPanel>()
    private dialog: ConfirmDialog | undefined
    private dialogIsPending = false
    private readonly emailBox = new TextBox()
    private readonly principalBox = new TextBox()
    private readonly passwordBox = new TextBox()
    private readonly form = new StackPanel()

    public constructor(source: IUsersAccessSource, currentPrincipalId: string)
    {
        super()
        this.vm = new UsersAccessViewModel(source, currentPrincipalId)
        this.accountList.Orientation = Orientation.Vertical
        this.BuildForm()
        const rerender = (): void => this.Render()
        this.vm.PropertyChanged(UsersAccessViewModel.RowsProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.EnvironmentsProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.SelectedEnvironmentProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.StateProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.ErrorProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.SelectedPrincipalIdProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.PendingProperty).subscribe(rerender)
        this.vm.PropertyChanged(UsersAccessViewModel.SelectedGrantsProperty).subscribe(rerender)
        this.Render()
    }

    // Test seam: the vertical list of account rows.
    public get AccountRows(): StackPanel
    {
        return this.accountList
    }

    // Test seam: the account row for a principal.
    public RowFor(principalId: string): StackPanel | undefined
    {
        return this.rowByPrincipal.get(principalId)
    }

    // Test seam: the hosted confirm dialog, if one is open.
    public get ActiveConfirm(): ConfirmDialog | undefined
    {
        return this.dialog
    }

    public async Refresh(): Promise<void>
    {
        await this.Act(() => this.vm.LoadEnvironments())
    }

    public Dispose(): void
    {
        this.dialog = undefined
    }

    public Render(): void
    {
        this.SyncPendingDialog()
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
                // Removing a child tears its subtree down, so the list is rebuilt on every render.
                this.UpdateRows()
                this.AddChild(this.accountList)
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
        if (this.dialog !== undefined)
        {
            this.AddChild(this.dialog)
        }
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

    private UpdateRows(): void
    {
        for (const child of [...this.accountList.Children])
        {
            this.accountList.RemoveChild(child)
        }
        this.rowByPrincipal.clear()
        for (const row of this.vm.Rows)
        {
            const panel = this.MakeAccountRow(row)
            this.rowByPrincipal.set(row.PrincipalId, panel)
            this.accountList.AddChild(panel)
        }
    }

    private MakeAccountRow(row: AccountRow): StackPanel
    {
        const panel = new StackPanel()
        panel.Orientation = Orientation.Horizontal
        panel.AddChild(this.MakeButton(row.Email, () => this.vm.SelectAccount(row.PrincipalId)))
        for (const role of row.Roles)
        {
            panel.AddChild(this.Text(role))
        }
        if (row.PrincipalId === this.vm.CurrentPrincipalId)
        {
            panel.AddChild(this.Text(UsersAccessView.YouTag))
        }
        panel.AddChild(new StatusPill(row.Disabled ? PillKind.Disabled : PillKind.Active))
        return panel
    }

    // Keeps the hosted dialog in step with the VM's DisableSelf pending state.
    private SyncPendingDialog(): void
    {
        const pending = this.vm.Pending
        const wanted = pending !== undefined && pending.kind === PendingKind.DisableSelf
        if (wanted && this.dialog === undefined)
        {
            this.OpenDisableDialog(this.vm.CurrentPrincipalId, true)
        }
        else if (!wanted && this.dialogIsPending && this.dialog !== undefined)
        {
            this.dialog = undefined
            this.dialogIsPending = false
        }
    }

    private OpenDisableDialog(principalId: string, selfLockout: boolean): void
    {
        const dialog: ConfirmDialog = new ConfirmDialog({
            title: UsersAccessView.DisableTitle,
            body: selfLockout ? UsersAccessView.SelfDisableWarning : undefined,
            consequences: [...UsersAccessView.DisableConsequences],
            actionLabel: UsersAccessView.DisableActionLabel,
            tone: ConfirmTone.Danger,
            onConfirm: () => { void this.Act(() => selfLockout ? this.vm.ConfirmPending() : this.vm.DisableAccount(principalId)) },
            onClose: () => this.CloseDialog(dialog),
        })
        this.dialog = dialog
        this.dialogIsPending = selfLockout
    }

    private CloseDialog(dialog: ConfirmDialog): void
    {
        if (this.dialog !== dialog)
        {
            return
        }
        const wasPending = this.dialogIsPending
        this.dialog = undefined
        this.dialogIsPending = false
        if (wasPending)
        {
            this.vm.CancelPending()
        }
        this.Render()
    }

    private RequestDisable(principalId: string): void
    {
        if (principalId === this.vm.CurrentPrincipalId)
        {
            void this.Act(() => this.vm.RequestDisable(principalId))
            return
        }
        if (this.dialog === undefined)
        {
            this.OpenDisableDialog(principalId, false)
            this.Render()
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
        // The VM clears each draft only on success, so the boxes follow it.
        this.emailBox.Text = vm.DraftEmail
        this.principalBox.Text = vm.DraftPrincipalId
        this.passwordBox.Text = vm.DraftPassword
    }

    private MakeSelectedSection(principalId: string): StackPanel
    {
        const vm = this.vm
        const section = new StackPanel()
        section.AddChild(this.Text(UsersAccessView.SelectedHeading + principalId))
        section.AddChild(this.MakeButton(UsersAccessView.DisableLabel, () => this.RequestDisable(principalId)))
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
        const confirming = pending !== undefined && pending.kind === PendingKind.RevokeSelf && UsersAccessView.SameGrant(vm.PendingGrant, grant)
        if (confirming)
        {
            row.AddChild(this.Text(UsersAccessView.SelfRevokeWarning))
            row.AddChild(this.MakeConfirmStrip(UsersAccessView.ConfirmRevokeLabel))
        }
        else
        {
            row.AddChild(this.MakeButton(UsersAccessView.RevokeLabel, () => { void this.Act(() => vm.RequestRevoke(grant)) }))
        }
        return row
    }

    private static SameGrant(a: GrantDto | undefined, b: GrantDto): boolean
    {
        return a !== undefined && a.subject === b.subject && a.role === b.role && a.resourceKind === b.resourceKind
            && a.resourcePath.length === b.resourcePath.length && a.resourcePath.every((seg, i) => seg === b.resourcePath[i])
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
