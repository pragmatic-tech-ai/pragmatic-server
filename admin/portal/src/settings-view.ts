import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ComboBox } from '@pragmatic-tech-ai/mural/framework'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { CreateOperatorViewModel } from './create-operator-view-model.js'
import { Act, ComboOption, DataTable, DeniedStatePanel, KeyActivatedButton, KeyValueGrid, OnceSecret, PageHeader, PillTone, ScreenHost, Section, TableDensity } from './kit/index.js'
import type { ScreenHostInputs, TableColumn } from './kit/index.js'
import { OperatorContext } from './operator-context.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'
import { SettingsViewModel } from './settings-view-model.js'
import type { OperatorRow } from './settings-view-model.js'

enum ManageArm
{
    None,
    Reset,
    Revoke,
}

export enum SettingsMode
{
    Normal,
    Invite,
    Manage,
    Reveal,
}

// Settings: the signed-in operator's session and, for operators only, the operator roster and a Full-gated invite action.
export class SettingsView extends StackPanel implements IPortalView
{
    private static readonly Breadcrumb: readonly string[] = ['Settings']
    private static readonly TitleText = 'Settings'
    private static readonly SessionTitle = 'Your session'
    private static readonly OperatorsTitle = 'Operators'
    private static readonly EmailLabel = 'Email'
    private static readonly RoleLabelText = 'Role'
    private static readonly OperatorKey = 'operator'
    private static readonly RoleKey = 'role'
    private static readonly OperatorHeader = 'Operator'
    private static readonly RoleHeader = 'Role'
    private static readonly SearchSeparator = ' '
    private static readonly OperatorsEmptyText = 'No operators are listed.'
    private static readonly DeniedWhat = 'the operator list'
    private static readonly EmptyTitle = 'Nothing to show.'
    private static readonly ErrorTitle = 'Could not load the operator list.'
    private static readonly InviteLabel = 'Invite operator'
    private static readonly InviteFormTitle = 'Invite an operator'
    private static readonly InviteSubmitLabel = 'Create operator'
    private static readonly CancelLabel = 'Cancel'
    private static readonly EmailPlaceholder = 'Email'
    private static readonly PasswordPlaceholder = 'Password'
    private static readonly RolePlaceholder = 'Role'
    private static readonly RequiredText = 'Email, password and role are required.'
    private static readonly FailedText = 'Could not create the operator.'
    private static readonly BlankText = ''
    private static readonly StatusKey = 'status'
    private static readonly StatusHeader = 'Status'
    private static readonly ActiveText = 'Active'
    private static readonly DisabledText = 'Disabled'
    private static readonly ManageTitle = 'Manage operator'
    private static readonly BackLabel = 'Back'
    private static readonly ChangeRoleLabel = 'Change role'
    private static readonly ResetPasswordLabel = 'Reset password'
    private static readonly DisableLabel = 'Disable operator'
    private static readonly EnableLabel = 'Enable operator'
    private static readonly RevokeLabel = 'Revoke sessions'
    private static readonly ConfirmResetLabel = 'Confirm reset password'
    private static readonly ConfirmRevokeLabel = 'Confirm revoke sessions'
    private static readonly DisarmLabel = 'Keep as is'
    private static readonly ManageFailedText = 'The action failed.'
    private static readonly RevealTitle = 'New password'
    private static readonly RevealSecretLabel = 'Temporary password (shown once)'
    private static readonly RevealConfirmLabel = 'I have saved the password'
    private static readonly LabelPath = 'Label'

    private readonly client: ControlPlaneClient
    private readonly operator: OperatorContext
    private readonly host: ScreenHost
    private readonly model: SettingsViewModel
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent.
    private sessionSlot = new StackPanel()
    private operatorsSlot = new StackPanel()
    private formSlot = new StackPanel()
    private mode = SettingsMode.Normal
    private errorText: TextBlock | undefined
    private roleBox: ComboBox | undefined
    private inviteAct: Act | undefined
    private manageEmail: string | undefined
    private manageRoleBox: ComboBox | undefined
    private manageError: TextBlock | undefined
    private changeRoleAct: Act | undefined
    private resetAct: Act | undefined
    private toggleAct: Act | undefined
    private revokeAct: Act | undefined
    private reveal: OnceSecret | undefined
    private armed = ManageArm.None
    private disarmButton: KeyActivatedButton | undefined
    private readonly createModel: CreateOperatorViewModel
    private nav: IPortalNavigator | undefined

    public constructor(client: ControlPlaneClient, operator: OperatorContext, email: string)
    {
        super()
        this.client = client
        this.operator = operator
        this.createModel = new CreateOperatorViewModel(client)
        this.model = new SettingsViewModel({ email, roleLabel: operator.RoleLabel })
        this.Orientation = Orientation.Vertical
        this.host = new ScreenHost(this.Inputs(true, false))
        this.AddChild(this.host)
    }

    // Test seam: the body host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the attached navigator.
    public get Navigator(): IPortalNavigator | undefined
    {
        return this.nav
    }

    // Test seam: the operators table (operator role, populated state only).
    public get Table(): DataTable<OperatorRow> | undefined
    {
        const child = [...this.operatorsSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<OperatorRow> : undefined
    }

    // Test seam: the current mode.
    public get Mode(): SettingsMode
    {
        return this.mode
    }

    // Test seam: the invite form's error line.
    public get ErrorLine(): string
    {
        return this.errorText?.Text ?? SettingsView.BlankText
    }

    // Test seam: the role picker of the open invite form.
    public get RoleBox(): ComboBox | undefined
    {
        return this.roleBox
    }

    // Test seam: the Full-gated Invite action (absent for observers).
    public get InviteAct(): Act | undefined
    {
        return this.inviteAct
    }

    // Test seam: the operator the Manage panel is open for.
    public get ManagedEmail(): string | undefined
    {
        return this.manageEmail
    }

    // Test seam: the role picker of the open Manage panel.
    public get ManageRoleBox(): ComboBox | undefined
    {
        return this.manageRoleBox
    }

    // Test seam: the Manage panel's inline error line.
    public get ManageErrorLine(): string
    {
        return this.manageError?.Text ?? SettingsView.BlankText
    }

    // Test seams: the four Manage actions (absent outside Manage mode).
    public get ChangeRoleAct(): Act | undefined
    {
        return this.changeRoleAct
    }

    public get ResetPasswordAct(): Act | undefined
    {
        return this.resetAct
    }

    public get ToggleDisabledAct(): Act | undefined
    {
        return this.toggleAct
    }

    public get RevokeSessionsAct(): Act | undefined
    {
        return this.revokeAct
    }

    // Test seam: the one-time password reveal (present only in Reveal mode).
    public get DisarmButton(): KeyActivatedButton | undefined
    {
        return this.disarmButton
    }

    public get Reveal(): OnceSecret | undefined
    {
        return this.reveal
    }

    // Re-renders from the held model with no network fetch. Manage needs an operator email; Reveal is internal only.
    public EnterMode(mode: SettingsMode, email?: string): void
    {
        // A shown one-time password (or an open invite form) is never navigated away from by a stray click.
        if (this.mode === SettingsMode.Reveal && (mode === SettingsMode.Manage || mode === SettingsMode.Invite))
        {
            return
        }
        if (this.mode === SettingsMode.Invite && mode === SettingsMode.Manage)
        {
            return
        }
        let next = mode
        if (!this.operator.CanMutate || mode === SettingsMode.Reveal)
        {
            next = SettingsMode.Normal
        }
        else if (mode === SettingsMode.Manage && (email === undefined || !this.model.Rows.some(r => r.email === email)))
        {
            next = SettingsMode.Normal
        }
        this.mode = next
        this.manageEmail = next === SettingsMode.Manage ? email : undefined
        this.reveal = undefined
        this.armed = ManageArm.None
        this.host.Update(this.Inputs(false, false, () => this.BuildContent(this.model)))
    }

    public AttachNavigator(nav: IPortalNavigator): void
    {
        this.nav = nav
    }

    public async Refresh(): Promise<void>
    {
        // An open invite form is left untouched: rebuilding it would discard what the operator is typing.
        if (this.mode !== SettingsMode.Normal)
        {
            return
        }
        // Only an operator may read the roster; an observer never triggers the fetch.
        if (this.operator.CanMutate)
        {
            this.host.Update(this.Inputs(true, false))
            try
            {
                this.model.Update(await this.client.ListOperators())
            }
            catch
            {
                this.ClearSlots()
                this.host.Update(this.Inputs(false, true))
                return
            }
        }
        this.host.Update(this.Inputs(false, false, () => this.BuildContent(this.model)))
    }

    private Inputs(loading: boolean, error: boolean, content?: () => Visual): ScreenHostInputs
    {
        return {
            loading,
            allowed: true,
            error,
            isEmpty: false,
            empty: { title: SettingsView.EmptyTitle },
            errorConfig: { title: SettingsView.ErrorTitle, onRetry: () => void this.Refresh() },
            content,
        }
    }

    private ClearSlots(): void
    {
        this.sessionSlot = new StackPanel()
        this.operatorsSlot = new StackPanel()
        this.formSlot = new StackPanel()
        this.errorText = undefined
        this.roleBox = undefined
        this.inviteAct = undefined
        this.manageRoleBox = undefined
        this.manageError = undefined
        this.changeRoleAct = undefined
        this.resetAct = undefined
        this.toggleAct = undefined
        this.revokeAct = undefined
        this.disarmButton = undefined
    }

    private BuildContent(model: SettingsViewModel): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(new PageHeader({ breadcrumb: SettingsView.Breadcrumb, title: SettingsView.TitleText }))
        // Fresh slots per render: the previous ones are still parented to the previous Sections.
        this.ClearSlots()
        this.sessionSlot.Orientation = Orientation.Vertical
        this.sessionSlot.AddChild(new KeyValueGrid({
            items: [
                { key: SettingsView.EmailLabel, value: model.Email },
                { key: SettingsView.RoleLabelText, value: model.RoleLabel },
            ],
        }))
        this.operatorsSlot.Orientation = Orientation.Vertical
        if (this.operator.CanMutate)
        {
            this.operatorsSlot.AddChild(new DataTable<OperatorRow>({
                columns: SettingsView.Columns(),
                rows: model.Rows,
                density: TableDensity.Dense,
                searchText: r => r.email + SettingsView.SearchSeparator + r.roleLabel + SettingsView.SearchSeparator + SettingsView.StatusText(r),
                emptyText: SettingsView.OperatorsEmptyText,
                onOpen: r => this.EnterMode(SettingsMode.Manage, r.email),
            }))
            this.inviteAct = new Act(this.operator.MutatingAct(SettingsView.InviteLabel, () => this.EnterMode(SettingsMode.Invite)))
            this.operatorsSlot.AddChild(this.inviteAct)
            this.formSlot.Orientation = Orientation.Vertical
            if (this.mode === SettingsMode.Invite)
            {
                this.formSlot.AddChild(this.BuildInviteForm())
                this.operatorsSlot.AddChild(new Section({ title: SettingsView.InviteFormTitle, body: this.formSlot }))
            }
            else if (this.mode === SettingsMode.Manage)
            {
                this.formSlot.AddChild(this.BuildManagePanel())
                this.operatorsSlot.AddChild(new Section({ title: SettingsView.ManageTitle, body: this.formSlot }))
            }
            else if (this.mode === SettingsMode.Reveal && this.reveal !== undefined)
            {
                this.formSlot.AddChild(this.reveal)
                this.operatorsSlot.AddChild(new Section({ title: SettingsView.RevealTitle, body: this.formSlot }))
            }
        }
        else
        {
            this.operatorsSlot.AddChild(new DeniedStatePanel({
                what: SettingsView.DeniedWhat,
                need: this.operator.NeededRoleLabel,
            }))
        }
        root.AddChild(new Section({ title: SettingsView.SessionTitle, body: this.sessionSlot }))
        root.AddChild(new Section({ title: SettingsView.OperatorsTitle, body: this.operatorsSlot }))
        return root
    }

    private BuildInviteForm(): Visual
    {
        const emailBox = new TextBox()
        emailBox.Placeholder = SettingsView.EmailPlaceholder
        const passwordBox = new TextBox()
        passwordBox.Placeholder = SettingsView.PasswordPlaceholder
        passwordBox.IsPassword = true
        const roleBox = new ComboBox()
        roleBox.Placeholder = SettingsView.RolePlaceholder
        roleBox.DisplayMemberPath = SettingsView.LabelPath
        const wires = [OperatorContext.FullWireRole, OperatorContext.ReadOnlyWireRole]
        roleBox.ItemsSource = wires.map(w => new ComboOption(OperatorContext.RoleLabel(w), w))
        roleBox.SelectedIndex = wires.indexOf(OperatorContext.ReadOnlyWireRole)
        this.roleBox = roleBox
        const errorText = new TextBlock()
        this.errorText = errorText
        const submit = new Act(this.operator.MutatingAct(
            SettingsView.InviteSubmitLabel,
            () => void this.Submit(emailBox.Text, passwordBox.Text, (roleBox.SelectedItem as ComboOption | undefined)?.Value ?? SettingsView.BlankText),
        ))
        const cancel = new KeyActivatedButton(() => this.EnterMode(SettingsMode.Normal))
        const cancelText = new TextBlock()
        cancelText.Text = SettingsView.CancelLabel
        cancel.Content = cancelText
        const body = new StackPanel()
        body.Orientation = Orientation.Vertical
        body.AddChild(emailBox)
        body.AddChild(passwordBox)
        body.AddChild(roleBox)
        body.AddChild(errorText)
        body.AddChild(submit)
        body.AddChild(cancel)
        return body
    }

    private BuildManagePanel(): Visual
    {
        const row = this.model.Rows.find(r => r.email === this.manageEmail)
        const body = new StackPanel()
        body.Orientation = Orientation.Vertical
        if (row === undefined)
        {
            return body
        }
        body.AddChild(new KeyValueGrid({
            items: [
                { key: SettingsView.EmailLabel, value: row.email },
                { key: SettingsView.RoleLabelText, value: row.roleLabel },
                { key: SettingsView.StatusHeader, value: SettingsView.StatusText(row) },
            ],
        }))
        const roleBox = new ComboBox()
        roleBox.Placeholder = SettingsView.RolePlaceholder
        roleBox.DisplayMemberPath = SettingsView.LabelPath
        const wires = [OperatorContext.FullWireRole, OperatorContext.ReadOnlyWireRole]
        roleBox.ItemsSource = wires.map(w => new ComboOption(OperatorContext.RoleLabel(w), w))
        roleBox.SelectedIndex = wires.indexOf(row.role)
        this.manageRoleBox = roleBox
        const errorText = new TextBlock()
        this.manageError = errorText
        const email = row.email
        this.changeRoleAct = new Act(this.operator.MutatingAct(SettingsView.ChangeRoleLabel, () => void this.RunManage(
            () => this.client.SetOperatorRole(email, (roleBox.SelectedItem as ComboOption | undefined)?.Value ?? row.role))))
        this.resetAct = new Act(this.operator.MutatingAct(
            this.armed === ManageArm.Reset ? SettingsView.ConfirmResetLabel : SettingsView.ResetPasswordLabel,
            () =>
            {
                if (this.armed === ManageArm.Reset)
                {
                    void this.ResetPassword(email)
                }
                else
                {
                    this.Arm(ManageArm.Reset)
                }
            }))
        this.toggleAct = new Act(this.operator.MutatingAct(
            row.disabled ? SettingsView.EnableLabel : SettingsView.DisableLabel,
            () => void this.RunManage(() => this.client.SetOperatorDisabled(email, !row.disabled))))
        this.revokeAct = new Act(this.operator.MutatingAct(
            this.armed === ManageArm.Revoke ? SettingsView.ConfirmRevokeLabel : SettingsView.RevokeLabel,
            () =>
            {
                if (this.armed === ManageArm.Revoke)
                {
                    void this.RunManage(() => this.client.RevokeOperatorSessions(email))
                }
                else
                {
                    this.Arm(ManageArm.Revoke)
                }
            }))
        const back = new KeyActivatedButton(() => this.EnterMode(SettingsMode.Normal))
        const backText = new TextBlock()
        backText.Text = SettingsView.BackLabel
        back.Content = backText
        body.AddChild(roleBox)
        body.AddChild(this.changeRoleAct)
        body.AddChild(this.resetAct)
        body.AddChild(this.toggleAct)
        body.AddChild(this.revokeAct)
        body.AddChild(errorText)
        if (this.armed !== ManageArm.None)
        {
            const disarm = new KeyActivatedButton(() => this.Arm(ManageArm.None))
            const disarmText = new TextBlock()
            disarmText.Text = SettingsView.DisarmLabel
            disarm.Content = disarmText
            this.disarmButton = disarm
            body.AddChild(disarm)
        }
        body.AddChild(back)
        return body
    }

    // Arms (or disarms) a destructive action: the next click on its button performs it.
    private Arm(arm: ManageArm): void
    {
        this.armed = arm
        this.host.Update(this.Inputs(false, false, () => this.BuildContent(this.model)))
    }

    // Runs one Manage mutation; success returns to Normal and re-fetches, failure shows the server's reason and keeps the panel open.
    private async RunManage(action: () => Promise<unknown>): Promise<void>
    {
        if (!this.operator.CanMutate)
        {
            return
        }
        try
        {
            await action()
        }
        catch (e)
        {
            this.ShowManageError(e)
            return
        }
        this.mode = SettingsMode.Normal
        this.manageEmail = undefined
        this.armed = ManageArm.None
        await this.Refresh()
    }

    // The new password goes straight from the response into the OnceSecret Visual; nothing else keeps it.
    private async ResetPassword(email: string): Promise<void>
    {
        if (!this.operator.CanMutate)
        {
            return
        }
        let result: { password: string }
        try
        {
            result = await this.client.ResetOperatorPassword(email)
        }
        catch (e)
        {
            this.ShowManageError(e)
            return
        }
        this.reveal = new OnceSecret({
            label: SettingsView.RevealSecretLabel,
            value: result.password,
            confirmLabel: SettingsView.RevealConfirmLabel,
            onConfirm: () => void this.DismissReveal(),
        })
        this.mode = SettingsMode.Reveal
        this.manageEmail = undefined
        this.armed = ManageArm.None
        this.host.Update(this.Inputs(false, false, () => this.BuildContent(this.model)))
    }

    private async DismissReveal(): Promise<void>
    {
        this.reveal = undefined
        this.mode = SettingsMode.Normal
        await this.Refresh()
    }

    private ShowManageError(e: unknown): void
    {
        if (this.manageError !== undefined)
        {
            this.manageError.Text = e instanceof Error && e.message.length > 0 ? e.message : SettingsView.ManageFailedText
        }
    }

    private static StatusText(r: OperatorRow): string
    {
        return r.disabled ? SettingsView.DisabledText : SettingsView.ActiveText
    }

    private async Submit(email: string, password: string, role: string): Promise<void>
    {
        if (this.errorText !== undefined)
        {
            this.errorText.Text = SettingsView.BlankText
        }
        if (!this.createModel.CanSubmit(email, password, role))
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = SettingsView.RequiredText
            }
            return
        }
        try
        {
            await this.createModel.Submit(email, password, role)
        }
        catch (e)
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = e instanceof Error && e.message.length > 0 ? e.message : SettingsView.FailedText
            }
            return
        }
        this.mode = SettingsMode.Normal
        await this.Refresh()
    }

    private static Columns(): TableColumn<OperatorRow>[]
    {
        return [
            {
                key: SettingsView.OperatorKey,
                header: SettingsView.OperatorHeader,
                cell: r => r.email,
                sort: (a, b) => a.email.localeCompare(b.email),
            },
            { key: SettingsView.RoleKey, header: SettingsView.RoleHeader, cell: r => r.roleLabel },
            {
                key: SettingsView.StatusKey,
                header: SettingsView.StatusHeader,
                cell: r => SettingsView.StatusText(r),
                tone: r => r.disabled ? PillTone.Danger : undefined,
            },
        ]
    }
}
