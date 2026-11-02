import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { OperatorContext } from '../../operator-context.js'
import { OptionViewModel } from '../../shell/option-view-model.js'
import { PortalDialogViewModel } from '../../shell/portal-dialog-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'

// Invite operator: an email, an initial password the operator hands over
// out of band, and a role (Observer by default: least privilege). The
// password is sent as typed, never trimmed, and cleared once the dialog has
// submitted; it is never shown back.
export class InviteOperatorDialogViewModel extends PortalDialogViewModel<string>
{
    private static readonly EmailProperty = 'Email'
    private static readonly PasswordProperty = 'Password'
    private static readonly SelectedRoleProperty = 'SelectedRole'
    private static readonly NoText = ''

    private readonly roles = new ObservableCollection<OptionViewModel<string>>()
    private email = InviteOperatorDialogViewModel.NoText
    private password = InviteOperatorDialogViewModel.NoText
    private selectedRole: OptionViewModel<string> | undefined

    public constructor(session: PortalSessionService, dialogs: DialogService)
    {
        super(session, dialogs)
        const observer = new OptionViewModel(OperatorContext.ReadOnlyWireRole, OperatorContext.RoleLabel(OperatorContext.ReadOnlyWireRole))
        this.roles.Add(observer)
        this.roles.Add(new OptionViewModel(OperatorContext.FullWireRole, OperatorContext.RoleLabel(OperatorContext.FullWireRole)))
        this.selectedRole = observer
    }

    public get Email(): string
    {
        return this.email
    }

    public set Email(value: string)
    {
        this.SetField(InviteOperatorDialogViewModel.EmailProperty, this.email, value, v => { this.email = v })
    }

    public get Password(): string
    {
        return this.password
    }

    public set Password(value: string)
    {
        this.SetField(InviteOperatorDialogViewModel.PasswordProperty, this.password, value, v => { this.password = v })
    }

    public get Roles(): ObservableCollection<OptionViewModel<string>>
    {
        return this.roles
    }

    public get SelectedRole(): OptionViewModel<string> | undefined
    {
        return this.selectedRole
    }

    public set SelectedRole(value: OptionViewModel<string> | undefined)
    {
        this.SetField(InviteOperatorDialogViewModel.SelectedRoleProperty, this.selectedRole, value, v => { this.selectedRole = v })
    }

    protected override get CanConfirm(): boolean
    {
        return this.email.trim().length > 0 && this.password.length > 0 && this.selectedRole !== undefined
    }

    // Returns the invited email; the password is cleared whether or not the
    // invite succeeded (a refusal asks for it again).
    protected override async SubmitCore(): Promise<string>
    {
        const email = this.email.trim()
        const password = this.password
        const role = this.selectedRole?.Value ?? OperatorContext.ReadOnlyWireRole
        try
        {
            await this.Session.Client.CreateOperator(email, password, role)
        }
        finally
        {
            this.Password = InviteOperatorDialogViewModel.NoText
        }
        return email
    }
}
