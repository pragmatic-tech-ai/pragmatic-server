import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { AppSessionService, type AppSession, type IPageReloader } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { ActivityLog } from '../activity-log.js'
import type { TenantApiClient } from '../tenant-api-client.js'
import type { TenantEvent, TenantProfileDto } from '../tenant-types.js'
import { AdminCapabilities, AdminCapability } from './admin-capability.js'
import { TenantShell } from './tenant-shell.js'

// The signed-in session for the shell: the shell's session service (expiry on 401, the access notice on 403, Log
// out; no own-password change, the credential belongs to the realm) plus the console's own facts: the fixed identity
// plate (organisation / tenant / hive), what the session may do (the profile's capabilities, which the server derives
// from the session's roles / app_roles claims) and the session's observed activity. Registered at the app root; the
// boot initializes it before any section resolves it.
export class TenantSessionService extends AppSessionService
{
    public static override readonly Key = new ServiceKey<TenantSessionService>('TenantSessionService')

    private static readonly EmailName = 'Email'
    private static readonly RoleLabelProperty = 'RoleLabel'
    private static readonly OrganisationLabelProperty = 'OrganisationLabel'
    private static readonly TenantLabelProperty = 'TenantLabel'
    private static readonly HiveLabelProperty = 'HiveLabel'
    private static readonly HasOrganisationProperty = 'HasOrganisation'
    private static readonly ActivityCountTextProperty = 'ActivityCountText'
    private static readonly NotSignedIn = 'Not signed in'
    private static readonly DeniedTemplate = 'Needs {need}. Ask {whom}.'
    private static readonly NeedToken = '{need}'
    private static readonly WhomToken = '{whom}'
    private static readonly DefaultWhom = 'your tenant owner'
    private static readonly HivePlaceholder = '(this hive)'
    private static readonly ActivityTemplate = 'Activity ({count})'
    private static readonly CountToken = '{count}'
    private static readonly Blank = ''

    private profile: TenantProfileDto | undefined
    private capabilities = new AdminCapabilities(undefined)
    private readonly activity = new ActivityLog()

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.activity.PropertyChanged(ActivityLog.EntriesProperty).subscribe(() =>
        {
            this.RaisePropertyChanged(TenantSessionService.ActivityCountTextProperty, undefined, this.ActivityCountText)
        })
    }

    // Binds the session and its profile. A missing profile (its read failed) leaves the capabilities permissive: the
    // server still refuses what is not allowed.
    public override Initialize(client: TenantApiClient, session: AppSession, reloader: IPageReloader, profile?: TenantProfileDto): void
    {
        const before = [this.Email, this.RoleLabel, this.OrganisationLabel, this.TenantLabel, this.HiveLabel, this.HasOrganisation] as const
        super.Initialize(client, session, reloader)
        this.profile = profile
        this.capabilities = new AdminCapabilities(profile?.capabilities)
        const P = TenantSessionService
        this.RaiseIfChanged(P.EmailName, before[0], this.Email)
        this.RaiseIfChanged(P.RoleLabelProperty, before[1], this.RoleLabel)
        this.RaiseIfChanged(P.OrganisationLabelProperty, before[2], this.OrganisationLabel)
        this.RaiseIfChanged(P.TenantLabelProperty, before[3], this.TenantLabel)
        this.RaiseIfChanged(P.HiveLabelProperty, before[4], this.HiveLabel)
        this.RaiseIfChanged(P.HasOrganisationProperty, before[5], this.HasOrganisation)
    }

    public override get Client(): TenantApiClient
    {
        return super.Client as TenantApiClient
    }

    // The profile as the server reported it; undefined when it could not be read.
    public get Profile(): TenantProfileDto | undefined
    {
        return this.profile
    }

    // The tenant the session belongs to (its `tenant` claim); '' before Initialize.
    public get TenantId(): string
    {
        return this.Session?.Claim(TenantShell.TenantClaim) ?? TenantSessionService.Blank
    }

    // Who is signed in: the profile's principal, else the session's subject (the realm's `sub`).
    public get PrincipalId(): string
    {
        return this.profile?.principalId ?? this.Subject
    }

    public override get Email(): string
    {
        return this.profile?.email ?? (super.Email || this.TenantId)
    }

    public get RoleLabel(): string
    {
        return this.profile?.roleLabel ?? TenantSessionService.Blank
    }

    // The identity plate: organisation / tenant / hive. Fixed; there is no switcher.
    public get OrganisationLabel(): string
    {
        return this.profile?.tenant.organisation ?? TenantSessionService.Blank
    }

    public get HasOrganisation(): boolean
    {
        return this.OrganisationLabel.length > 0
    }

    public get TenantLabel(): string
    {
        return this.profile?.tenant.displayName ?? this.TenantId
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
        return this.IsSignedIn && this.capabilities.Has(capability)
    }

    // Why a command needing `capability` is disabled; '' when it is allowed.
    public DeniedReason(capability: AdminCapability): string
    {
        if (!this.IsSignedIn)
        {
            return TenantSessionService.NotSignedIn
        }
        if (this.Can(capability))
        {
            return TenantSessionService.Blank
        }
        return TenantSessionService.DeniedTemplate
            .replace(TenantSessionService.NeedToken, AdminCapabilities.NameOf(capability))
            .replace(TenantSessionService.WhomToken, this.OwnerContact)
    }

    // The hive serving this tenant: the profile's, else the first the tenant surface lists (a tenant has exactly
    // one). Undefined when there is none.
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
}
