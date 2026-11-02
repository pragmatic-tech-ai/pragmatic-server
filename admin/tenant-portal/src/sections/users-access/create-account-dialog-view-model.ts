import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { AdminCapability } from '../../shell/admin-capability.js'
import { TenantDialogViewModel } from '../../shell/tenant-dialog-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'

// Create account in one environment: the person's email, the principal id
// the identity provider knows them by, and an initial password. The password
// is input only: it is never echoed back, and it is cleared once the dialog
// closes (created, cancelled or dismissed). Resolves with the principal id.
export class CreateAccountDialogViewModel extends TenantDialogViewModel<string>
{
    private static readonly NoText = ''
    private static readonly EmailProperty = 'Email'
    private static readonly PrincipalIdProperty = 'PrincipalId'
    private static readonly PasswordProperty = 'Password'
    private static readonly EmailMark = '@'

    private email = ''
    private principalId = ''
    private password = ''

    public constructor(session: TenantSessionService, dialogs: DialogService, private readonly environment: string)
    {
        super(session, dialogs, AdminCapability.Access)
    }

    public get Environment(): string
    {
        return this.environment
    }

    public get Email(): string
    {
        return this.email
    }

    public set Email(value: string)
    {
        this.SetField(CreateAccountDialogViewModel.EmailProperty, this.email, value, v => { this.email = v })
    }

    public get PrincipalId(): string
    {
        return this.principalId
    }

    public set PrincipalId(value: string)
    {
        this.SetField(CreateAccountDialogViewModel.PrincipalIdProperty, this.principalId, value, v => { this.principalId = v })
    }

    // Bound to a masked TextBox; nothing else reads it.
    public get Password(): string
    {
        return this.password
    }

    public set Password(value: string)
    {
        this.SetField(CreateAccountDialogViewModel.PasswordProperty, this.password, value, v => { this.password = v })
    }

    // Whatever closes the dialog, the typed password does not outlive it.
    public override async Open(title: string): Promise<string | undefined>
    {
        try
        {
            return await super.Open(title)
        }
        finally
        {
            this.Password = CreateAccountDialogViewModel.NoText
        }
    }

    protected override get CanConfirm(): boolean
    {
        return this.email.trim().includes(CreateAccountDialogViewModel.EmailMark)
            && this.principalId.trim().length > 0
            && this.password.length > 0
    }

    protected override async SubmitCore(): Promise<string>
    {
        const principalId = this.principalId.trim()
        const params = { email: this.email.trim(), principalId, password: this.password }
        await this.Session.Client.CreateAccount(this.environment, params)
        this.Password = CreateAccountDialogViewModel.NoText
        return principalId
    }
}
