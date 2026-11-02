import { RelayCommand, ServiceBase, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { ApiError, type ControlPlaneClient } from '../api-client.js'
import type { OperatorContext } from '../operator-context.js'
import type { IPageReloader } from './page-reloader.js'

// The signed-in session for the shell: the control-plane client, who is signed
// in, and what they may do. Registered at the app root; main.ts initializes it
// before any section resolves it. Logout and expiry reload the page.
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

    private client: ControlPlaneClient | undefined
    private email = ''
    private operator: OperatorContext | undefined
    private reloader: IPageReloader | undefined
    private expired = false
    private logoutError = ''
    private loggingOut = false
    private readonly logoutCommand: RelayCommand

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.logoutCommand = new RelayCommand(() => { void this.Logout() }, () => !this.loggingOut, { Text: PortalSessionService.LogoutText })
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

    // Ends the session for this page: reloads at most once, landing on login.
    public Expire(): void
    {
        if (this.expired)
        {
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
