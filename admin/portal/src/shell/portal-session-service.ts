import { RelayCommand, ServiceBase, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { ApiError, type ControlPlaneClient } from '../api-client.js'
import { ChangePasswordDialogViewModel } from './change-password-dialog-view-model.js'
import type { OperatorContext } from '../operator-context.js'
import type { IPageReloader } from './page-reloader.js'

// The signed-in session for the shell: the control-plane client, who is signed
// in, and what they may do. Registered at the app root; main.ts initializes it
// before any section resolves it. Logout and expiry reload the page.
// Change password opens the own-password dialog for any role; once it lands,
// AccountNotice says so (the operator's other sessions were signed out).
export class PortalSessionService extends ServiceBase
{
    public static readonly Key = new ServiceKey<PortalSessionService>('PortalSessionService')

    private static readonly EmailProperty = 'Email'
    private static readonly RoleLabelProperty = 'RoleLabel'
    private static readonly CanMutateProperty = 'CanMutate'
    private static readonly DeniedReasonProperty = 'DeniedReason'
    private static readonly ReadOnlyNoticeProperty = 'ReadOnlyNotice'
    private static readonly LogoutErrorProperty = 'LogoutError'
    private static readonly NotInitialized = 'PortalSessionService used before Initialize.'
    private static readonly NotSignedIn = 'Not signed in'
    private static readonly DeniedTemplate = 'Needs the {role} role. Ask {whom}.'
    private static readonly ReadOnlyTemplate = 'Read-only: you are signed in as {role}.'
    private static readonly RoleToken = '{role}'
    private static readonly WhomToken = '{whom}'
    private static readonly LogoutText = 'Log out'
    private static readonly ChangePasswordText = 'Change password'
    private static readonly ChangePasswordTitle = 'Change your password'
    private static readonly AccountNoticeProperty = 'AccountNotice'
    private static readonly PasswordChangedNotice = 'Password changed. Your other sessions were signed out.'
    private static readonly NoDialogsMessage = 'Dialogs are not available.'
    private static readonly NoText = ''

    private client: ControlPlaneClient | undefined
    private email = ''
    private operator: OperatorContext | undefined
    private reloader: IPageReloader | undefined
    private expired = false
    private logoutError = ''
    private loggingOut = false
    private accountNotice = ''
    private changingPassword = false
    private expirySuspensions = 0
    private expiryDeferred = false
    private readonly logoutCommand: RelayCommand
    private readonly changePasswordCommand: RelayCommand

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.logoutCommand = new RelayCommand(() => { void this.Logout() }, () => !this.loggingOut, { Text: PortalSessionService.LogoutText })
        this.changePasswordCommand = new RelayCommand(() => { void this.ChangePassword() },
            () => !this.changingPassword && this.operator !== undefined, { Text: PortalSessionService.ChangePasswordText })
    }

    public Initialize(client: ControlPlaneClient, email: string, operator: OperatorContext, reloader: IPageReloader): void
    {
        const oldEmail = this.Email
        const oldRoleLabel = this.RoleLabel
        const oldCanMutate = this.CanMutate
        const oldDeniedReason = this.DeniedReason
        const oldReadOnlyNotice = this.ReadOnlyNotice
        this.client = client
        this.email = email
        this.operator = operator
        this.reloader = reloader
        this.expired = false
        this.RaisePropertyChanged(PortalSessionService.EmailProperty, oldEmail, this.Email)
        this.RaisePropertyChanged(PortalSessionService.RoleLabelProperty, oldRoleLabel, this.RoleLabel)
        this.RaisePropertyChanged(PortalSessionService.CanMutateProperty, oldCanMutate, this.CanMutate)
        this.RaisePropertyChanged(PortalSessionService.DeniedReasonProperty, oldDeniedReason, this.DeniedReason)
        this.RaisePropertyChanged(PortalSessionService.ReadOnlyNoticeProperty, oldReadOnlyNotice, this.ReadOnlyNotice)
        this.changePasswordCommand.RaiseCanExecuteChanged()
    }

    public get Client(): ControlPlaneClient
    {
        if (this.client === undefined)
        {
            throw new Error(PortalSessionService.NotInitialized)
        }
        return this.client
    }

    public get Email(): string
    {
        return this.email
    }

    public get RoleLabel(): string
    {
        return this.operator?.RoleLabel ?? ''
    }

    public get CanMutate(): boolean
    {
        return this.operator?.CanMutate ?? false
    }

    // Why a mutating command is disabled; '' when the operator may mutate.
    public get DeniedReason(): string
    {
        if (this.operator === undefined)
        {
            return PortalSessionService.NotSignedIn
        }
        if (this.CanMutate)
        {
            return ''
        }
        return PortalSessionService.DeniedTemplate
            .replace(PortalSessionService.RoleToken, this.operator.NeededRoleLabel)
            .replace(PortalSessionService.WhomToken, this.operator.AskWhom)
    }

    // The header's read-only notice for Observers; '' when the operator may mutate.
    public get ReadOnlyNotice(): string
    {
        if (this.CanMutate || this.operator === undefined)
        {
            return ''
        }
        return PortalSessionService.ReadOnlyTemplate.replace(PortalSessionService.RoleToken, this.operator.RoleLabel)
    }

    // Why the last logout failed; '' when none. A failed logout keeps the page.
    public get LogoutError(): string
    {
        return this.logoutError
    }

    public get LogoutCommand(): RelayCommand
    {
        return this.logoutCommand
    }

    // Opens the change-password dialog; any role may change their own password.
    public get ChangePasswordCommand(): RelayCommand
    {
        return this.changePasswordCommand
    }

    // What the last account action did ('Password changed...'); '' when none.
    public get AccountNotice(): string
    {
        return this.accountNotice
    }

    // Asks for the current and a new password and changes it. Only one dialog
    // at a time; a failure inside it stays in the dialog. Resolves once the
    // dialog closes.
    public async ChangePassword(): Promise<void>
    {
        if (this.changingPassword)
        {
            return
        }
        const dialogs = this.Provider.get(DialogService.Key)
        if (dialogs === undefined)
        {
            this.SetAccountNotice(PortalSessionService.NoDialogsMessage)
            return
        }
        this.SetChangingPassword(true)
        this.SetAccountNotice(PortalSessionService.NoText)
        try
        {
            const changed = await new ChangePasswordDialogViewModel(this, dialogs).Open(PortalSessionService.ChangePasswordTitle)
            if (changed !== undefined)
            {
                this.SetAccountNotice(changed.warning ?? PortalSessionService.PasswordChangedNotice)
            }
        }
        catch (e)
        {
            this.SetAccountNotice(e instanceof Error ? e.message : String(e))
        }
        finally
        {
            this.SetChangingPassword(false)
        }
    }

    // Runs `work` (a password change) with expiry suspended: the server ends the
    // old session before the fresh cookie lands, so a page request answered 401
    // meanwhile is not the session ending. Such a 401 is remembered, and once
    // the work is done the session is checked once: expired only if it is gone.
    public async WithExpirySuspended<T>(work: () => Promise<T>): Promise<T>
    {
        this.expirySuspensions++
        try
        {
            return await work()
        }
        finally
        {
            this.expirySuspensions--
            if (this.expirySuspensions === 0 && this.expiryDeferred)
            {
                this.expiryDeferred = false
                await this.RecheckSession()
            }
        }
    }

    // Ends the session for this page: reloads at most once, landing on login.
    // While expiry is suspended it is only remembered (see WithExpirySuspended).
    public Expire(): void
    {
        if (this.expired)
        {
            return
        }
        if (this.expirySuspensions > 0)
        {
            this.expiryDeferred = true
            return
        }
        this.expired = true
        this.reloader?.Reload()
    }

    // Signs out, then reloads to login. A 401 means the session is already
    // gone, so it reloads too; any other failure leaves the operator signed in,
    // so it reports the error and stays on the page.
    // A second call while one is in flight is a no-op.
    public async Logout(): Promise<void>
    {
        if (this.loggingOut)
        {
            return
        }
        this.SetLoggingOut(true)
        this.SetLogoutError('')
        try
        {
            await this.Client.Logout()
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
            {
                this.Expire()
                return
            }
            this.SetLogoutError(e instanceof Error ? e.message : String(e))
            return
        }
        finally
        {
            this.SetLoggingOut(false)
        }
        this.Expire()
    }

    // The deferred check: expires when the server says there is no session; a
    // failed check keeps the page (the next request decides).
    private async RecheckSession(): Promise<void>
    {
        let alive: boolean
        try
        {
            alive = (await this.Client.Session()) !== null
        }
        catch
        {
            alive = true
        }
        if (!alive)
        {
            this.Expire()
        }
    }

    private SetChangingPassword(next: boolean): void
    {
        this.changingPassword = next
        this.changePasswordCommand.RaiseCanExecuteChanged()
    }

    private SetAccountNotice(next: string): void
    {
        const old = this.accountNotice
        if (old === next)
        {
            return
        }
        this.accountNotice = next
        this.RaisePropertyChanged(PortalSessionService.AccountNoticeProperty, old, next)
    }

    private SetLoggingOut(next: boolean): void
    {
        this.loggingOut = next
        this.logoutCommand.RaiseCanExecuteChanged()
    }

    private SetLogoutError(next: string): void
    {
        const old = this.logoutError
        if (old === next)
        {
            return
        }
        this.logoutError = next
        this.RaisePropertyChanged(PortalSessionService.LogoutErrorProperty, old, next)
    }
}
