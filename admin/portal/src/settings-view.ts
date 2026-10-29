import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ComboBox } from '@pragmatic-tech-ai/mural/framework'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { CreateOperatorViewModel } from './create-operator-view-model.js'
import { HiveOption } from './create-hive-view.js'
import { Act, DataTable, DeniedStatePanel, KeyActivatedButton, KeyValueGrid, PageHeader, ScreenHost, Section, TableDensity } from './kit/index.js'
import type { ScreenHostInputs, TableColumn } from './kit/index.js'
import { OperatorContext } from './operator-context.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'
import { SettingsViewModel } from './settings-view-model.js'
import type { OperatorRow } from './settings-view-model.js'

export enum SettingsMode
{
    Normal,
    Invite,
}

// Settings: the signed-in operator's session and, for operators only, the operator roster. Read-only.
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

    // Re-renders from the held model with no network fetch.
    public EnterMode(mode: SettingsMode): void
    {
        this.mode = mode
        this.host.Update(this.Inputs(false, false, () => this.BuildContent(this.model)))
    }

    public AttachNavigator(nav: IPortalNavigator): void
    {
        this.nav = nav
    }

    public async Refresh(): Promise<void>
    {
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
        this.mode = SettingsMode.Normal
    }

    private BuildContent(model: SettingsViewModel): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(new PageHeader({ breadcrumb: SettingsView.Breadcrumb, title: SettingsView.TitleText }))
        // Fresh slots per render: the previous ones are still parented to the previous Sections.
        // ClearSlots resets the mode, so carry it across the rebuild.
        const mode = this.mode
        this.ClearSlots()
        this.mode = mode
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
                searchText: r => r.email + SettingsView.SearchSeparator + r.roleLabel,
                emptyText: SettingsView.OperatorsEmptyText,
            }))
            this.inviteAct = new Act(this.operator.MutatingAct(SettingsView.InviteLabel, () => this.EnterMode(SettingsMode.Invite)))
            this.operatorsSlot.AddChild(this.inviteAct)
            this.formSlot.Orientation = Orientation.Vertical
            if (this.mode === SettingsMode.Invite)
            {
                this.formSlot.AddChild(this.BuildInviteForm())
                this.operatorsSlot.AddChild(new Section({ title: SettingsView.InviteFormTitle, body: this.formSlot }))
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
        roleBox.ItemsSource = wires.map(w => new HiveOption(OperatorContext.RoleLabel(w), w))
        roleBox.SelectedIndex = wires.indexOf(OperatorContext.ReadOnlyWireRole)
        this.roleBox = roleBox
        const errorText = new TextBlock()
        this.errorText = errorText
        const submit = new Act(this.operator.MutatingAct(
            SettingsView.InviteSubmitLabel,
            () => void this.Submit(emailBox.Text, passwordBox.Text, (roleBox.SelectedItem as HiveOption | undefined)?.Value ?? SettingsView.BlankText),
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
        ]
    }
}
