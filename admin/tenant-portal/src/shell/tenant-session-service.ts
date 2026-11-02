import { RelayCommand, ServiceBase, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { ActivityLog } from '../activity-log.js'
import { TenantApiError, type TenantApiClient } from '../tenant-api-client.js'
import type { SessionDto, TenantEvent, TenantProfileDto } from '../tenant-types.js'
import { AdminCapabilities, AdminCapability } from './admin-capability.js'
import type { IPageReloader } from './page-reloader.js'

// The signed-in session for the shell: the tenant API client, who is signed in,
// the fixed identity plate (organisation / tenant / hive), what they may do,
// and the session's observed activity. Registered at the app root; TenantBoot
// initializes it before any section resolves it. Logout and expiry reload the
// page, which lands on sign-in.
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

    private client: TenantApiClient | undefined
    private session: SessionDto | undefined
    private profile: TenantProfileDto | undefined
    private capabilities = new AdminCapabilities(undefined)
    private reloader: IPageReloader | undefined
    private expired = false
    private logoutError = ''
    private loggingOut = false
    private readonly activity = new ActivityLog()
    private readonly logoutCommand: RelayCommand

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.logoutCommand = new RelayCommand(() => { void this.Logout() }, () => !this.loggingOut, { Text: TenantSessionService.LogoutText })
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
        return this.session?.principalId ?? ''
    }

    public get Email(): string
    {
        return this.profile?.email ?? this.session?.email ?? this.session?.tenantId ?? ''
    }

    public get RoleLabel(): string
    {
        return this.profile?.roleLabel ?? ''
    }

    // The identity plate: organisation / tenant / hive. Fixed; there is no switcher.
    public get OrganisationLabel(): string
    {
        return this.profile?.environment.organisation ?? ''
    }

    public get HasOrganisation(): boolean
    {
        return this.OrganisationLabel.length > 0
    }

    public get TenantLabel(): string
    {
        return this.profile?.environment.displayName ?? this.session?.tenantId ?? ''
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
            return ''
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

    // Ends the session for this page: reloads at most once, landing on sign-in.
    public Expire(): void
    {
        if (this.expired)
        {
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
        this.SetLogoutError('')
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
