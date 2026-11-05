import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantApiError } from '../../tenant-api-client.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { UtcText } from '../../shell/utc-text.js'
import type { EmailDomainsDto, HiveDto, TenantProfileDto } from '../../tenant-types.js'
import { EmailDomainsEditorViewModel } from './email-domains-editor-view-model.js'

// The Settings page's tabs, in order.
export enum SettingsTab
{
    Hive,
    Profile,
    IdentityProvider,
    EmailDomains,
}

// One key / value line of a settings tab.
export class SettingRowViewModel extends Observable
{
    public constructor(private readonly key: string, private readonly value: string)
    {
        super()
    }

    public get Key(): string
    {
        return this.key
    }

    public get Value(): string
    {
        return this.value
    }
}

// Settings: how the tenant is set up. Tabs Hive & domain, Tenant profile and
// Identity provider (credentials by reference only: Configured / Not
// configured) are read-only, platform-managed values: the page itself exposes
// no command. The fourth tab, Email domains, is the one editor: its
// EmailDomainsEditorViewModel lets the tenant Owner change the domains (others
// see them read-only). A failed email-domain read never fails the page: a 404
// leaves that tab read-only, any other failure shows its sentence in the tab.
// A 403 is Denied; no profile is Empty.
export class SettingsPageViewModel extends TenantPageViewModel
{
    private static readonly SelectedTabProperty = 'SelectedTab'
    private static readonly IsHiveTabProperty = 'IsHiveTab'
    private static readonly IsProfileTabProperty = 'IsProfileTab'
    private static readonly IsIdentityProviderTabProperty = 'IsIdentityProviderTab'
    private static readonly IsEmailDomainsTabProperty = 'IsEmailDomainsTab'
    private static readonly HiveRowsProperty = 'HiveRows'
    private static readonly ProfileRowsProperty = 'ProfileRows'
    private static readonly IdpRowsProperty = 'IdpRows'
    private static readonly HasHiveProperty = 'HasHive'
    private static readonly HasNoHiveProperty = 'HasNoHive'
    private static readonly HasIdpProperty = 'HasIdp'
    private static readonly HasNoIdpProperty = 'HasNoIdp'
    private static readonly NotFoundStatus = 404
    private static readonly TabHive ='Hive & domain'
    private static readonly TabProfile = 'Tenant profile'
    private static readonly TabIdp = 'Identity provider'
    private static readonly TabEmailDomains = 'Email domains'
    private static readonly KeyHiveName = 'Hive name'
    private static readonly KeyClusterBackend = 'Cluster backend'
    private static readonly KeyClusterMode = 'Cluster mode'
    private static readonly KeyRegistryMode = 'Registry mode'
    private static readonly KeyRegistryEndpoint = 'Registry endpoint'
    private static readonly KeyCreated = 'Created'
    private static readonly KeyTenantName = 'Tenant name'
    private static readonly KeyTenantId = 'Tenant id'
    private static readonly KeyOrganisation = 'Organisation'
    private static readonly KeyOwner = 'Owner contact'
    private static readonly KeyRole = 'Your role'
    private static readonly KeyHive = 'Hive'
    private static readonly KeyBaseUrl = 'Base URL'
    private static readonly KeySigningCa = 'Signing CA'
    private static readonly KeyAdminToken = 'Admin token'
    private static readonly Configured = 'Configured'
    private static readonly NotConfigured = 'Not configured'
    private static readonly NoBaseUrl = 'No base URL set.'

    private readonly tabLabels = new ObservableCollection<string>()
    private readonly emailDomains: EmailDomainsEditorViewModel
    private tab = SettingsTab.Hive
    private profile: TenantProfileDto | undefined
    private hive: HiveDto | undefined
    private hiveRows = new ObservableCollection<SettingRowViewModel>()
    private profileRows = new ObservableCollection<SettingRowViewModel>()
    private idpRows = new ObservableCollection<SettingRowViewModel>()

    public constructor(session: TenantSessionService)
    {
        super(session)
        this.emailDomains = new EmailDomainsEditorViewModel(session)
        for (const label of SettingsPageViewModel.Labels)
        {
            this.tabLabels.Add(label)
        }
    }

    private static get Labels(): readonly string[]
    {
        const P = SettingsPageViewModel
        return [P.TabHive, P.TabProfile, P.TabIdp, P.TabEmailDomains]
    }

    // The tab strip's labels, in SettingsTab order.
    public get TabLabels(): ObservableCollection<string>
    {
        return this.tabLabels
    }

    public get Tab(): SettingsTab
    {
        return this.tab
    }

    public set Tab(next: SettingsTab)
    {
        const old = this.tab
        if (old === next)
        {
            return
        }
        const P = SettingsPageViewModel
        const was = [this.SelectedTab, this.IsHiveTab, this.IsProfileTab, this.IsIdentityProviderTab, this.IsEmailDomainsTab] as const
        this.tab = next
        this.RaisePropertyChanged(P.SelectedTabProperty, was[0], this.SelectedTab)
        this.RaisePropertyChanged(P.IsHiveTabProperty, was[1], this.IsHiveTab)
        this.RaisePropertyChanged(P.IsProfileTabProperty, was[2], this.IsProfileTab)
        this.RaisePropertyChanged(P.IsIdentityProviderTabProperty, was[3], this.IsIdentityProviderTab)
        this.RaisePropertyChanged(P.IsEmailDomainsTabProperty, was[4], this.IsEmailDomainsTab)
    }

    // The selected tab's label (two-way with the tab strip).
    public get SelectedTab(): string
    {
        return SettingsPageViewModel.Labels[this.tab]
    }

    public set SelectedTab(label: string)
    {
        const index = SettingsPageViewModel.Labels.indexOf(label)
        if (index >= 0)
        {
            this.Tab = index as SettingsTab
        }
    }

    public get IsHiveTab(): boolean
    {
        return this.tab === SettingsTab.Hive
    }

    public get IsProfileTab(): boolean
    {
        return this.tab === SettingsTab.Profile
    }

    public get IsIdentityProviderTab(): boolean
    {
        return this.tab === SettingsTab.IdentityProvider
    }

    public get IsEmailDomainsTab(): boolean
    {
        return this.tab === SettingsTab.EmailDomains
    }

    // The Email domains tab's editor.
    public get EmailDomains(): EmailDomainsEditorViewModel
    {
        return this.emailDomains
    }

    public get HiveRows():ObservableCollection<SettingRowViewModel>
    {
        return this.hiveRows
    }

    // Only the profile fields the server reported.
    public get ProfileRows(): ObservableCollection<SettingRowViewModel>
    {
        return this.profileRows
    }

    public get IdpRows(): ObservableCollection<SettingRowViewModel>
    {
        return this.idpRows
    }

    public get HasHive(): boolean
    {
        return this.hive !== undefined
    }

    public get HasNoHive(): boolean
    {
        return !this.HasHive
    }

    public get HasIdp(): boolean
    {
        return this.profile?.idp !== undefined
    }

    public get HasNoIdp(): boolean
    {
        return !this.HasIdp
    }

    // The profile, the tenant's one hive and its email domains, read together. The email-domain read never fails
    // the page: a 404 leaves that tab read-only, a 401 expires the session, any other failure shows in the tab.
    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const client = this.Session.Client
        const [profile, hives, domains] = await Promise.all([client.Profile(), client.ListHives(), SettingsPageViewModel.ReadEmailDomains(client.GetEmailDomains())])
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.Apply(profile, hives[0])
        this.ApplyEmailDomains(domains, profile?.capabilities.settings === true)
        return this.profile !== undefined
    }

    // The email-domain read as a value: the dto, a TenantApiError to show in the tab, or a thrown 401.
    private static async ReadEmailDomains(read: Promise<EmailDomainsDto>): Promise<EmailDomainsDto | TenantApiError | Error>
    {
        try
        {
            return await read
        }
        catch (e)
        {
            if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
            {
                throw e
            }
            return e instanceof Error ? e : new Error(String(e))
        }
    }

    private ApplyEmailDomains(result: EmailDomainsDto | Error, canChangeSettings: boolean): void
    {
        if (!(result instanceof Error))
        {
            this.emailDomains.Apply(result, canChangeSettings)
        }
        else if (result instanceof TenantApiError && result.Status === SettingsPageViewModel.NotFoundStatus)
        {
            this.emailDomains.ApplyUnavailable()
        }
        else
        {
            this.emailDomains.ApplyFailure(result.message)
        }
    }

    private Apply(profile: TenantProfileDto | undefined, hive: HiveDto | undefined): void
    {
        const P = SettingsPageViewModel
        const before = [this.HasHive, this.HasIdp] as const
        const old = [this.hiveRows, this.profileRows, this.idpRows] as const
        this.profile = profile
        this.hive = hive
        this.hiveRows = SettingsPageViewModel.Rows(SettingsPageViewModel.HiveItems(hive))
        this.profileRows = SettingsPageViewModel.Rows(SettingsPageViewModel.ProfileItems(profile))
        this.idpRows = SettingsPageViewModel.Rows(SettingsPageViewModel.IdpItems(profile))
        this.RaisePropertyChanged(P.HiveRowsProperty, old[0], this.hiveRows)
        this.RaisePropertyChanged(P.ProfileRowsProperty, old[1], this.profileRows)
        this.RaisePropertyChanged(P.IdpRowsProperty, old[2], this.idpRows)
        this.RaisePropertyChanged(P.HasHiveProperty, before[0], this.HasHive)
        this.RaisePropertyChanged(P.HasNoHiveProperty, !before[0], this.HasNoHive)
        this.RaisePropertyChanged(P.HasIdpProperty, before[1], this.HasIdp)
        this.RaisePropertyChanged(P.HasNoIdpProperty, !before[1], this.HasNoIdp)
    }

    private static Rows(items: ReadonlyArray<readonly [string, string]>): ObservableCollection<SettingRowViewModel>
    {
        const rows = new ObservableCollection<SettingRowViewModel>()
        for (const [key, value] of items)
        {
            rows.Add(new SettingRowViewModel(key, value))
        }
        return rows
    }

    private static HiveItems(hive: HiveDto | undefined): Array<readonly [string, string]>
    {
        if (hive === undefined)
        {
            return []
        }
        const P = SettingsPageViewModel
        const items: Array<readonly [string, string]> = [
            [P.KeyHiveName, hive.displayName],
            [P.KeyClusterBackend, hive.cluster.backend],
            [P.KeyClusterMode, hive.cluster.mode],
            [P.KeyRegistryMode, hive.registry.mode],
        ]
        if (hive.registry.endpoint !== undefined)
        {
            items.push([P.KeyRegistryEndpoint, hive.registry.endpoint])
        }
        items.push([P.KeyCreated, UtcText.DateTime(hive.createdAt)])
        return items
    }

    private static ProfileItems(profile: TenantProfileDto | undefined): Array<readonly [string, string]>
    {
        if (profile === undefined)
        {
            return []
        }
        const P = SettingsPageViewModel
        const items: Array<readonly [string, string]> = [
            [P.KeyTenantName, profile.environment.displayName],
            [P.KeyTenantId, profile.environment.id],
        ]
        if (profile.environment.organisation !== undefined)
        {
            items.push([P.KeyOrganisation, profile.environment.organisation])
        }
        if (profile.ownerContact !== undefined)
        {
            items.push([P.KeyOwner, profile.ownerContact])
        }
        items.push([P.KeyRole, profile.roleLabel])
        if (profile.hive !== undefined)
        {
            items.push([P.KeyHive, profile.hive.displayName])
        }
        return items
    }

    // By reference only: the base URL and whether each credential is set.
    private static IdpItems(profile: TenantProfileDto | undefined): Array<readonly [string, string]>
    {
        const idp = profile?.idp
        if (idp === undefined)
        {
            return []
        }
        const P = SettingsPageViewModel
        return [
            [P.KeyBaseUrl, idp.baseUrl ?? P.NoBaseUrl],
            [P.KeySigningCa, SettingsPageViewModel.Presence(idp.signingCaConfigured)],
            [P.KeyAdminToken, SettingsPageViewModel.Presence(idp.adminTokenConfigured)],
        ]
    }

    private static Presence(configured: boolean): string
    {
        return configured ? SettingsPageViewModel.Configured : SettingsPageViewModel.NotConfigured
    }
}
