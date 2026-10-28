import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { KeyValueGrid, KitGlyph, PillKind, ScreenHost, Section, SkeletonKind, StatusPill, Tabs } from './kit/index.js'
import type { KeyValueItem, ScreenHostInputs } from './kit/index.js'
import { SettingsState, SettingsViewModel } from './settings-view-model.js'
import type { ISettingsSource } from './settings-view-model.js'
import { TenantApiError } from './tenant-api-client.js'
import { TenantViewBase } from './tenant-view-base.js'

// Read-only Settings page. Every value is platform-managed: there is deliberately no edit,
// rotate or revoke control, because no backend exists for those actions.
export class SettingsView extends TenantViewBase
{
    public static readonly Title = 'Settings'
    public static readonly Sub = 'Read-only view of how your tenant is set up.'
    public static readonly TabHive = 'Hive & domain'
    public static readonly TabProfile = 'Tenant profile'
    public static readonly TabIdp = 'Identity provider'
    public static readonly HiveNote = 'These settings are managed by the platform and are read-only here.'
    public static readonly ProfileNote = 'Profile changes are made by the platform operator.'
    public static readonly IdpNote = 'Identity provider credentials are managed by the platform and are shown by reference only.'
    public static readonly KeyHiveName = 'Hive name'
    public static readonly KeyClusterBackend = 'Cluster backend'
    public static readonly KeyClusterMode = 'Cluster mode'
    public static readonly KeyRegistryMode = 'Registry mode'
    public static readonly KeyRegistryEndpoint = 'Registry endpoint'
    public static readonly KeyCreated = 'Created'
    public static readonly KeyTenantName = 'Tenant name'
    public static readonly KeyTenantId = 'Tenant id'
    public static readonly KeyOrganisation = 'Organisation'
    public static readonly KeyOwner = 'Owner contact'
    public static readonly KeyRole = 'Your role'
    public static readonly KeyHive = 'Hive'
    public static readonly KeyBaseUrl = 'Base URL'
    public static readonly KeySigningCa = 'Signing CA'
    public static readonly KeyAdminToken = 'Admin token'
    public static readonly Configured = 'Configured'
    public static readonly NotConfigured = 'Not configured'
    public static readonly NoHive = 'No hive has been set up for this tenant yet.'
    public static readonly NoIdp = 'No identity provider configured'
    public static readonly NoBaseUrl = 'No base URL set.'
    public static readonly EmptyTitle = 'No settings to show yet.'
    public static readonly ErrorTitle = 'Could not load the settings.'
    public static readonly DeniedWhat = 'the settings'
    public static readonly DeniedNeed = 'access to your tenant'

    private readonly vm: SettingsViewModel
    private readonly subscriptions: IDisposable[] = []
    private readonly hiveHost = new StackPanel()
    private readonly profileHost = new StackPanel()
    private readonly idpHost = new StackPanel()
    private readonly tabs: Tabs
    private readonly host: ScreenHost
    private localError: string | undefined

    public constructor(source: ISettingsSource)
    {
        super()
        this.vm = new SettingsViewModel(source)
        this.Orientation = Orientation.Vertical
        for (const panel of [this.hiveHost, this.profileHost, this.idpHost])
        {
            panel.Orientation = Orientation.Vertical
        }
        this.tabs = new Tabs({ entries: [
            { label: SettingsView.TabHive, content: this.hiveHost },
            { label: SettingsView.TabProfile, content: this.profileHost },
            { label: SettingsView.TabIdp, content: this.idpHost },
        ] })
        const names = [SettingsViewModel.StateProperty, SettingsViewModel.ProfileProperty, SettingsViewModel.HiveProperty, SettingsViewModel.ErrorProperty]
        for (const name of names)
        {
            this.subscriptions.push(this.vm.PropertyChanged(name).subscribe(() => this.Rebuild()))
        }
        this.host = new ScreenHost(this.Inputs())
        this.AddChild(new Section({ title: SettingsView.Title, sub: SettingsView.Sub, body: this.host }))
        this.Rebuild()
    }

    // Test seam: the underlying view model.
    public get Vm(): SettingsViewModel
    {
        return this.vm
    }

    // Test seam: the tab strip.
    public get Tabs(): Tabs
    {
        return this.tabs
    }

    // Test seam: the state host.
    public get StateHost(): ScreenHost
    {
        return this.host
    }

    public get HiveTab(): StackPanel
    {
        return this.hiveHost
    }

    public get ProfileTab(): StackPanel
    {
        return this.profileHost
    }

    public get IdpTab(): StackPanel
    {
        return this.idpHost
    }

    public async Refresh(): Promise<void>
    {
        this.localError = undefined
        try
        {
            await this.vm.Load()
        }
        catch (e)
        {
            this.ReportError(e)
        }
        this.Rebuild()
    }

    public Dispose(): void
    {
        for (const s of this.subscriptions)
        {
            s.dispose()
        }
        this.subscriptions.length = 0
    }

    private ReportError(e: unknown): void
    {
        if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus && this.Navigator !== undefined)
        {
            this.ShowError(e)
            return
        }
        this.localError = e instanceof Error ? e.message : String(e)
    }

    private Inputs(): ScreenHostInputs
    {
        const state = this.vm.State
        const failed = state === SettingsState.Error || this.localError !== undefined
        return {
            loading: state === SettingsState.Loading && this.localError === undefined,
            allowed: state !== SettingsState.Forbidden,
            isEmpty: state === SettingsState.NoData,
            error: failed,
            skeleton: SkeletonKind.Cards,
            empty: { glyph: KitGlyph.Settings, title: SettingsView.EmptyTitle },
            errorConfig: failed ? { title: SettingsView.ErrorTitle, body: this.localError ?? this.vm.Error } : undefined,
            denied: { what: SettingsView.DeniedWhat, need: SettingsView.DeniedNeed },
            content: this.tabs,
        }
    }

    private Rebuild(): void
    {
        this.RebuildHive()
        this.RebuildProfile()
        this.RebuildIdp()
        this.host.Update(this.Inputs())
    }

    private static Clear(panel: StackPanel): void
    {
        for (const child of [...panel.Children])
        {
            panel.RemoveChild(child)
        }
    }

    private static Text(text: string): TextBlock
    {
        const block = new TextBlock()
        block.Text = text
        return block
    }

    private static Fill(panel: StackPanel, items: KeyValueItem[], note: string): void
    {
        SettingsView.Clear(panel)
        panel.AddChild(SettingsView.Text(note))
        panel.AddChild(new KeyValueGrid({ items }))
    }

    private RebuildHive(): void
    {
        const hive = this.vm.Hive
        if (hive === undefined)
        {
            SettingsView.Clear(this.hiveHost)
            this.hiveHost.AddChild(SettingsView.Text(SettingsView.HiveNote))
            this.hiveHost.AddChild(SettingsView.Text(SettingsView.NoHive))
            return
        }
        const items: KeyValueItem[] = [
            { key: SettingsView.KeyHiveName, value: hive.displayName },
            { key: SettingsView.KeyClusterBackend, value: hive.cluster.backend },
            { key: SettingsView.KeyClusterMode, value: hive.cluster.mode },
            { key: SettingsView.KeyRegistryMode, value: hive.registry.mode },
        ]
        if (hive.registry.endpoint !== undefined)
        {
            items.push({ key: SettingsView.KeyRegistryEndpoint, value: hive.registry.endpoint })
        }
        items.push({ key: SettingsView.KeyCreated, value: hive.createdAt })
        SettingsView.Fill(this.hiveHost, items, SettingsView.HiveNote)
    }

    private RebuildProfile(): void
    {
        const p = this.vm.Profile
        if (p === undefined)
        {
            SettingsView.Clear(this.profileHost)
            return
        }
        const items: KeyValueItem[] = [
            { key: SettingsView.KeyTenantName, value: p.tenant.displayName },
            { key: SettingsView.KeyTenantId, value: p.tenant.id },
        ]
        if (p.tenant.organisation !== undefined)
        {
            items.push({ key: SettingsView.KeyOrganisation, value: p.tenant.organisation })
        }
        if (p.ownerContact !== undefined)
        {
            items.push({ key: SettingsView.KeyOwner, value: p.ownerContact })
        }
        items.push({ key: SettingsView.KeyRole, value: p.roleLabel })
        if (p.hive !== undefined)
        {
            items.push({ key: SettingsView.KeyHive, value: p.hive.displayName })
        }
        SettingsView.Fill(this.profileHost, items, SettingsView.ProfileNote)
    }

    private RebuildIdp(): void
    {
        SettingsView.Clear(this.idpHost)
        this.idpHost.AddChild(SettingsView.Text(SettingsView.IdpNote))
        const idp = this.vm.Profile?.idp
        if (idp === undefined)
        {
            this.idpHost.AddChild(SettingsView.Text(SettingsView.NoIdp))
            return
        }
        this.idpHost.AddChild(new KeyValueGrid({ items: [{ key: SettingsView.KeyBaseUrl, value: idp.baseUrl ?? SettingsView.NoBaseUrl }], cols: 1 }))
        this.idpHost.AddChild(new KeyValueGrid({ items: [
            { key: SettingsView.KeySigningCa, value: SettingsView.Presence(idp.signingCaConfigured) },
            { key: SettingsView.KeyAdminToken, value: SettingsView.Presence(idp.adminTokenConfigured) },
        ] }))
    }

    private static Presence(configured: boolean): StatusPill
    {
        const pill = new StatusPill(configured ? PillKind.Active : PillKind.Disabled)
        pill.LabelOverride = configured ? SettingsView.Configured : SettingsView.NotConfigured
        return pill
    }
}
