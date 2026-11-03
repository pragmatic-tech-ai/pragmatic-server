import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { PortalDialogViewModel } from './portal-dialog-view-model.js'
import type { PortalSessionService } from './portal-session-service.js'

// Change my password: the signed-in operator's current password, a new one
// and its confirmation. Any role may confirm (it acts on their own account
// only). Confirm stays disabled until the current password is filled, the new
// one is long enough and differs from it, and the confirmation matches;
// NewPasswordText and MismatchText say why while they do not. The passwords
// are input only: never echoed back, and cleared whenever the dialog closes
// (changed, cancelled or dismissed). A wrong current password keeps the
// dialog open with the server's reason in ErrorText.
export class ChangePasswordDialogViewModel extends PortalDialogViewModel<boolean>
{
    public static readonly Changed = true
    // The control plane's floor for an operator password (its MinOperatorPasswordLength).
    public static readonly MinPasswordLength = 12

    private static readonly CurrentPasswordProperty = 'CurrentPassword'
    private static readonly NewPasswordProperty = 'NewPassword'
    private static readonly ConfirmPasswordProperty = 'ConfirmPassword'
    private static readonly NewPasswordTextProperty = 'NewPasswordText'
    private static readonly MismatchTextProperty = 'MismatchText'
    private static readonly TooShortText = 'Use at least ' + ChangePasswordDialogViewModel.MinPasswordLength + ' characters.'
    private static readonly SameText = 'The new password must differ from the current one.'
    private static readonly NoMatchText = 'The two new passwords do not match.'
    private static readonly NoText = ''

    private currentPassword = ChangePasswordDialogViewModel.NoText
    private newPassword = ChangePasswordDialogViewModel.NoText
    private confirmPassword = ChangePasswordDialogViewModel.NoText

    public constructor(session: PortalSessionService, dialogs: DialogService)
    {
        super(session, dialogs)
    }

    // Who the change is for: always the signed-in operator.
    public get Email(): string
    {
        return this.Session.Email
    }

    public get CurrentPassword(): string
    {
        return this.currentPassword
    }

    public set CurrentPassword(value: string)
    {
        this.SetPassword(ChangePasswordDialogViewModel.CurrentPasswordProperty, this.currentPassword, value, v => { this.currentPassword = v })
    }

    public get NewPassword(): string
    {
        return this.newPassword
    }

    public set NewPassword(value: string)
    {
        this.SetPassword(ChangePasswordDialogViewModel.NewPasswordProperty, this.newPassword, value, v => { this.newPassword = v })
    }

    public get ConfirmPassword(): string
    {
        return this.confirmPassword
    }

    public set ConfirmPassword(value: string)
    {
        this.SetPassword(ChangePasswordDialogViewModel.ConfirmPasswordProperty, this.confirmPassword, value, v => { this.confirmPassword = v })
    }

    // Why the new password is not acceptable yet, once something is typed; '' when it is.
    public get NewPasswordText(): string
    {
        if (this.newPassword.length === 0)
        {
            return ChangePasswordDialogViewModel.NoText
        }
        if (this.newPassword.length < ChangePasswordDialogViewModel.MinPasswordLength)
        {
            return ChangePasswordDialogViewModel.TooShortText
        }
        return this.newPassword === this.currentPassword ? ChangePasswordDialogViewModel.SameText : ChangePasswordDialogViewModel.NoText
    }

    // Why Confirm is off while the confirmation differs from the new password; '' before it is typed.
    public get MismatchText(): string
    {
        return this.confirmPassword.length === 0 || this.confirmPassword === this.newPassword
            ? ChangePasswordDialogViewModel.NoText
            : ChangePasswordDialogViewModel.NoMatchText
    }

    // Whatever closes the dialog, the typed passwords do not outlive it.
    public override async Open(title: string): Promise<boolean | undefined>
    {
        try
        {
            return await super.Open(title)
        }
        finally
        {
            this.Clear()
        }
    }

    protected override get RequiresMutate(): boolean
    {
        return false
    }

    protected override get CanConfirm(): boolean
    {
        return this.currentPassword.length > 0
            && this.newPassword.length >= ChangePasswordDialogViewModel.MinPasswordLength
            && this.newPassword !== this.currentPassword
            && this.confirmPassword === this.newPassword
    }

    protected override async SubmitCore(): Promise<boolean>
    {
        await this.Session.Client.ChangeOwnPassword(this.currentPassword, this.newPassword, this.confirmPassword)
        this.Clear()
        return ChangePasswordDialogViewModel.Changed
    }

    private Clear(): void
    {
        this.CurrentPassword = ChangePasswordDialogViewModel.NoText
        this.NewPassword = ChangePasswordDialogViewModel.NoText
        this.ConfirmPassword = ChangePasswordDialogViewModel.NoText
    }

    // Sets one password field and re-raises the two validation texts it can change.
    private SetPassword(name: string, old: string, next: string, assign: (value: string) => void): void
    {
        const oldNewText = this.NewPasswordText
        const oldMismatch = this.MismatchText
        this.SetField(name, old, next, assign)
        this.RaiseIfChanged(ChangePasswordDialogViewModel.NewPasswordTextProperty, oldNewText, this.NewPasswordText)
        this.RaiseIfChanged(ChangePasswordDialogViewModel.MismatchTextProperty, oldMismatch, this.MismatchText)
    }

    private RaiseIfChanged(name: string, old: string, next: string): void
    {
        if (old !== next)
        {
            this.RaisePropertyChanged(name, old, next)
        }
    }
}
