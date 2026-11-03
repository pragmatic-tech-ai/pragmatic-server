import { RelayCommand, ServiceBase, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { ActivityLog } from '../activity-log.js'
import { TenantApiError, type TenantApiClient } from '../tenant-api-client.js'
import type { SessionDto, TenantEvent, TenantProfileDto } from '../tenant-types.js'
import { AdminCapabilities, AdminCapability } from './admin-capability.js'
import { ChangePasswordDialogViewModel } from './change-password-dialog-view-model.js'
import type { IPageReloader } from './page-reloader.js'

// The signed-in session for the shell: the tenant API client, who is signed in,
// the fixed identity plate (organisation / tenant / hive), what they may do,
// and the session's observed activity. Registered at the app root; TenantBoot
// initializes it before any section resolves it. Logout and expiry reload the
// page, which lands on sign-in. Change password opens the own-password
// dialog (no permission needed); once it lands, AccountNotice says what it did.
export class TenantSessionService extends ServiceBase
{
    public static readonly Key = new ServiceKey<TenantSessionService>('TenantSessionService')

    private static readonly EmailProperty = 'Email'
    private static readonly RoleLabelProperty = 'RoleLabel'
    private static readonly OrganisationLabelProperty = 'OrganisationLabel'
    private static readonly TenantLabelProperty = 'TenantLabel'
    private static readonly HiveLabelProperty = 'HiveLabel'
    private static readonly HasOrganisationProperty = 'HasOrganisation'
    private static readonly LogoutErrorProperty = 'LogoutError'
    private static readonly ActivityCountTextProperty = 'ActivityCountText'
    private static readonly NotInitialized = 'TenantSessionService used before Initialize.'
    private static readonly NotSignedIn = 'Not signed in'
    private static readonly DeniedTemplate = 'Needs {need}. Ask {whom}.'
    private static readonly NeedToken = '{need}'
    private static readonly WhomToken = '{whom}'
    private static readonly DefaultWhom = 'your tenant owner'
    private static readonly HivePlaceholder = '(this hive)'
    private static readonly LogoutText = 'Log out'
    private static readonly ActivityTemplate = 'Activity ({count})'
    private static readonly CountToken = '{count}'
    private static readonly NoText = ''
    private static readonly ChangePasswordText = 'Change password'
    private static readonly ChangePasswordTitle = 'Change your password'
    private static readonly AccountNoticeProperty = 'AccountNotice'
    private static readonly PasswordChangedNotice = 'Password changed. Your other sessions were signed out.'
    private static readonly NoDialogsMessage = 'Dialogs are not available.'
    private static readonly NoEmailReason = 'This sign-in carries no email, so its password cannot be changed here.'
    private static readonly ChangePasswordDeniedReasonProperty = 'ChangePasswordDeniedReason'

    private client: TenantApiClient | undefined
    private session: SessionDto | undefined
    private profile: TenantProfileDto | undefined
    private capabilities = new AdminCapabilities(undefined)
    private reloader: IPageReloader | undefined
    private expired = false
    private logoutError = ''
    private loggingOut = false
    private accountNotice = ''
    private changingPassword = false
    private expirySuspensions = 0
    private expiryDeferred = false
    private readonly activity = new ActivityLog()
    private readonly logoutCommand: RelayCommand
    private readonly changePasswordCommand: RelayCommand

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.logoutCommand = new RelayCommand(() => { void this.Logout() }, () => !this.loggingOut, { Text: TenantSessionService.LogoutText })
        this.changePasswordCommand = new RelayCommand(() => { void this.ChangePassword() },
            () => !this.changingPassword && this.CanChangePassword, { Text: TenantSessionService.ChangePasswordText })
        this.activity.PropertyChanged(ActivityLog.EntriesProperty).subscribe(() =>
        {
            this.RaisePropertyChanged(TenantSessionService.ActivityCountTextProperty, undefined, this.ActivityCountText)
        })
    }

    // Binds the session. A missing profile (its read failed) leaves the
    // capabilities permissive: the server still refuses what is not allowed.
    public Initialize(client: TenantApiClient, session: SessionDto, profile: TenantProfileDto | undefined, reloader: IPageReloader): void
    {
        const before = [this.Email, this.RoleLabel, this.OrganisationLabel, this.TenantLabel, this.HiveLabel, this.HasOrganisation] as const
        const beforeDenied = this.ChangePasswordDeniedReason
        this.client = client
        this.session = session
        this.profile = profile
        this.capabilities = new AdminCapabilities(profile?.capabilities)
        this.reloader = reloader
        this.expired = false
        const P = TenantSessionService
        this.RaisePropertyChanged(P.EmailProperty, before[0], this.Email)
        this.RaisePropertyChanged(P.RoleLabelProperty, before[1], this.RoleLabel)
        this.RaisePropertyChanged(P.OrganisationLabelProperty, before[2], this.OrganisationLabel)
        this.RaisePropertyChanged(P.TenantLabelProperty, before[3], this.TenantLabel)
        this.RaisePropertyChanged(P.HiveLabelProperty, before[4], this.HiveLabel)
        this.RaisePropertyChanged(P.HasOrganisationProperty, before[5], this.HasOrganisation)
        this.RaisePropertyChanged(P.ChangePasswordDeniedReasonProperty, beforeDenied, this.ChangePasswordDeniedReason)
        this.changePasswordCommand.RaiseCanExecuteChanged()
    }

    public get Client(): TenantApiClient
    {
        if (this.client === undefined)
        {
            throw new Error(TenantSessionService.NotInitialized)
        }
        return this.client
    }

    // The profile as the server reported it; undefined when it could not be read.
    public get Profile(): TenantProfileDto | undefined
    {
        return this.profile
    }

    public get PrincipalId(): string
    {
        return this.session?.principalId ?? TenantSessionService.NoText
    }

    public get Email(): string
    {
        return this.profile?.email ?? this.session?.email ?? this.session?.tenantId ?? TenantSessionService.NoText
    }

    public get RoleLabel(): string
    {
        return this.profile?.roleLabel ?? TenantSessionService.NoText
    }

    // The identity plate: organisation / tenant / hive. Fixed; there is no switcher.
    public get OrganisationLabel(): string
    {
        return this.profile?.environment.organisation ?? TenantSessionService.NoText
    }

    public get HasOrganisation(): boolean
    {
        return this.OrganisationLabel.length > 0
    }

    public get TenantLabel(): string
    {
        return this.profile?.environment.displayName ?? this.session?.tenantId ?? TenantSessionService.NoText
    }

    public get HiveLabel(): string
    {
        return this.profile?.hive?.displayName ?? TenantSessionService.HivePlaceholder
    }

    // Who grants missing permissions: the profile's owner contact when known.
    public get OwnerContact(): string
    {
        return this.profile?.ownerContact ?? TenantSessionService.DefaultWhom
    }

    public Can(capability: AdminCapability): boolean
    {
        return this.session !== undefined && this.capabilities.Has(capability)
    }

    // Why a command needing `capability` is disabled; '' when it is allowed.
    public DeniedReason(capability: AdminCapability): string
    {
        if (this.session === undefined)
        {
            return TenantSessionService.NotSignedIn
        }
        if (this.Can(capability))
        {
            return TenantSessionService.NoText
        }
        return TenantSessionService.DeniedTemplate
            .replace(TenantSessionService.NeedToken, AdminCapabilities.NameOf(capability))
            .replace(TenantSessionService.WhomToken, this.OwnerContact)
    }

    // The hive serving this tenant: the profile's, else the first the tenant
    // surface lists (a tenant has exactly one). Undefined when there is none.
    public async ResolveHiveId(): Promise<string | undefined>
    {
        const fromProfile = this.profile?.hive?.id
        if (fromProfile !== undefined)
        {
            return fromProfile
        }
        const hives = await this.Client.ListHives()
        return hives[0]?.id
    }

    // The tenant events observed this session, newest first. Not persisted.
    public get Activity(): ActivityLog
    {
        return this.activity
    }

    public get ActivityCountText(): string
    {
        return TenantSessionService.ActivityTemplate.replace(TenantSessionService.CountToken, String(this.activity.Count))
    }

    public RecordEvent(ev: TenantEvent): void
    {
        this.activity.Record(ev)
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

    // Opens the change-password dialog for the signed-in user's own account.
    public get ChangePasswordCommand(): RelayCommand
    {
        return this.changePasswordCommand
    }

    // Whether the signed-in user can change their password here: the server
    // changes it by the session's email, so a sign-in without one cannot.
    public get CanChangePassword(): boolean
    {
        const email = this.session?.email
        return email !== undefined && email.length > 0
    }

    // Why Change password is off; '' when it is available.
    public get ChangePasswordDeniedReason(): string
    {
        return this.session === undefined || this.CanChangePassword ? TenantSessionService.NoText : TenantSessionService.NoEmailReason
    }

    // What the last account action did ('Password changed...'); '' when none.
    public get AccountNotice(): string
    {
        return this.accountNotice
    }

    // Asks for the current and a new password and changes it. One dialog at a
    // time; a failure inside it stays in the dialog. Resolves once it closes.
    public async ChangePassword(): Promise<void>
    {
        if (this.changingPassword || !this.CanChangePassword)
        {
            return
        }
        const dialogs = this.Provider.get(DialogService.Key)
        if (dialogs === undefined)
        {
            this.SetAccountNotice(TenantSessionService.NoDialogsMessage)
            return
        }
        this.SetChangingPassword(true)
        this.SetAccountNotice(TenantSessionService.NoText)
        try
        {
            const changed = await new ChangePasswordDialogViewModel(this, dialogs).Open(TenantSessionService.ChangePasswordTitle)
            if (changed !== undefined)
            {
                this.SetAccountNotice(changed.warning ?? TenantSessionService.PasswordChangedNotice)
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

    // Ends the session for this page: reloads at most once, landing on sign-in.
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

    // Signs out, then reloads to sign-in. A 401 means the session is already
    // gone, so it reloads too; any other failure leaves the operator signed in,
    // so it reports the error and stays on the page. A second call while one
    // is in flight is a no-op.
    public async Logout(): Promise<void>
    {
        if (this.loggingOut)
        {
            return
        }
        this.SetLoggingOut(true)
        this.SetLogoutError(TenantSessionService.NoText)
        try
        {
            await this.Client.Logout()
        }
        catch (e)
        {
            if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
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
        this.RaisePropertyChanged(TenantSessionService.AccountNoticeProperty, old, next)
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
        this.RaisePropertyChanged(TenantSessionService.LogoutErrorProperty, old, next)
    }
}
