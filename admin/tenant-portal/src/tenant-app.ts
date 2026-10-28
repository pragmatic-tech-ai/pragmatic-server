import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import { ComingSoonView } from './coming-soon-view.js'
import { ConnectionStatusView } from './connection-status-view.js'
import { CreateEnvironmentDialog } from './create-environment-dialog.js'
import { EnvironmentDetailView } from './environment-detail-view.js'
import { EnvironmentsView } from './environments-view.js'
import { EnvironmentsViewModel } from './environments-view-model.js'
import { HiveDetailView } from './hive-detail-view.js'
import { IdentityPlate } from './identity-plate.js'
import { NavModel, NavSection } from './nav-model.js'
import { NavRail } from './nav-rail.js'
import { OverviewView } from './overview-view.js'
import { ReleasesView } from './releases-view.js'
import { TenantApiClient } from './tenant-api-client.js'
import { TenantViewBase } from './tenant-view-base.js'
import { TenantEventType } from './tenant-types.js'
import type { AdminCapabilitiesDto, EnvironmentDto, HiveDto, ITenantNavigator, ITenantView, SessionDto, TenantEvent, TenantProfileDto } from './tenant-types.js'
import { TopBar } from './top-bar.js'
import { UserMenu } from './user-menu.js'
import { ServiceTokensView } from './service-tokens-view.js'
import { UsersAccessPageView } from './users-access-page-view.js'

// Root shell: auth-gated boot; a nav rail on the left, and on the right a top bar over the section content host.
export class TenantApp extends StackPanel implements ITenantNavigator
{
    public static readonly TitleText = 'Pragmatic Tenant Admin'
    // Fallback hive label when the profile is absent or carries no hive; the plate shows the profile hive name otherwise.
    public static readonly HivePlaceholder = '(this hive)'

    private readonly client: TenantApiClient
    private readonly navRail: NavRail
    private readonly rightColumn = new StackPanel()
    private readonly topHost = new StackPanel()
    private readonly detailHost = new StackPanel()
    // Minimal dialog layer: holds the open create dialog (if any) above the content pane.
    private readonly dialogHost = new StackPanel()
    // Populated by Boot; stays undefined when the profile read fails (permissive fallback).
    private profile: TenantProfileDto | undefined
    private current: ITenantView | undefined
    // Name of the environment the detail pane is showing, so a delete of it swaps the pane back rather than refreshing a gone env.
    private currentEnvName: string | undefined
    // Operator's principal from the Boot session; UsersAccessView uses it to guard self-disable.
    private currentPrincipalId = ''
    private active: NavSection = NavSection.Overview
    // Live-event host: set only while the environments list is the shown view.
    private environments: EnvironmentsView | undefined
    private eventUnsub: (() => void) | undefined

    public constructor(client: TenantApiClient = new TenantApiClient())
    {
        super()
        this.client = client
        this.navRail = new NavRail(s => this.ShowSection(s), this.active)
        this.Orientation = Orientation.Horizontal
        this.rightColumn.Orientation = Orientation.Vertical
        this.rightColumn.AddChild(this.topHost)
        this.rightColumn.AddChild(this.dialogHost)
        this.rightColumn.AddChild(this.detailHost)
        this.AddChild(this.navRail)
        this.AddChild(this.rightColumn)
    }

    // Probes the session cookie: signed in -> Overview, otherwise (null or any failure) -> login.
    public async Boot(): Promise<void>
    {
        let session: SessionDto | null
        try
        {
            session = await this.client.Session()
        }
        catch
        {
            session = null
        }
        if (session === null)
        {
            this.ShowLogin()
            return
        }
        this.currentPrincipalId = session.principalId
        try
        {
            this.profile = await this.client.Profile()
        }
        catch
        {
            this.profile = undefined
        }
        this.BuildTopBar(session)
        this.eventUnsub?.()
        this.eventUnsub = this.client.OnEvent(ev => this.OnTenantEvent(ev))
        this.ShowSection(NavSection.Overview)
    }

    public ShowLogin(): void
    {
        this.Teardown()
        this.client.BeginLogin()
    }

    public get Profile(): TenantProfileDto | undefined
    {
        return this.profile
    }

    public get Capabilities(): AdminCapabilitiesDto | undefined
    {
        return this.profile?.capabilities
    }

    public get OwnerContact(): string | undefined
    {
        return this.profile?.ownerContact
    }

    public ShowSection(section: NavSection): void
    {
        this.active = section
        this.navRail.SetActive(section)
        switch (section)
        {
            case NavSection.Environments:
                this.ShowEnvironments()
                break
            case NavSection.UsersAccess:
                this.Show(new UsersAccessPageView(this.client, this.currentPrincipalId))
                break
            case NavSection.Overview:
                void this.ShowOverview()
                break
            case NavSection.Releases:
                void this.ShowReleases()
                break
            case NavSection.ConnectionStatus:
                this.Show(new ConnectionStatusView(this.client))
                break
            default:
                this.Show(new ComingSoonView(TenantApp.LabelFor(section)))
                break
        }
    }

    public ShowHiveDetail(hive: HiveDto): void
    {
        this.MarkEnvironmentsActive()
        this.Show(new HiveDetailView(this.client, hive))
    }

    public ShowEnvironmentDetail(env: EnvironmentDto): void
    {
        this.MarkEnvironmentsActive()
        this.Show(new EnvironmentDetailView(this.client, env, env.hiveId))
        this.currentEnvName = env.name
    }

    public ShowUsersAccess(): void
    {
        this.ShowSection(NavSection.UsersAccess)
    }

    public ShowServiceTokens(): void
    {
        this.Show(new ServiceTokensView(this.client))
    }

    public get ActiveSection(): NavSection
    {
        return this.active
    }

    public get CurrentPrincipalId(): string
    {
        return this.currentPrincipalId
    }

    private static LabelFor(section: NavSection): string
    {
        return NavModel.Items.find(i => i.Section === section)?.Label ?? ''
    }

    private BuildTopBar(session: SessionDto): void
    {
        const profile = this.profile
        const plate = new IdentityPlate({
            org: profile?.tenant.organisation,
            tenant: profile?.tenant.displayName ?? session.tenantId,
            hive: profile?.hive?.displayName ?? TenantApp.HivePlaceholder
        })
        const userMenu = new UserMenu({
            email: profile?.email ?? session.email ?? session.tenantId,
            roleLabel: profile?.roleLabel,
            onLogout: () => { void this.Logout() }
        })
        this.Clear(this.topHost)
        this.topHost.AddChild(new TopBar({ plate, userMenu }))
    }

    private async ShowOverview(): Promise<void>
    {
        let hiveId = this.profile?.hive?.id
        if (hiveId === undefined)
        {
            try
            {
                hiveId = (await this.client.ListHives())[0]?.id
            }
            catch
            {
                hiveId = undefined
            }
        }
        if (this.active !== NavSection.Overview)
        {
            return
        }
        this.Show(hiveId === undefined ? new ComingSoonView(TenantApp.LabelFor(NavSection.Overview)) : new OverviewView(this.client, hiveId))
    }

    private async ShowReleases(): Promise<void>
    {
        let hiveId = this.profile?.hive?.id
        if (hiveId === undefined)
        {
            try
            {
                hiveId = (await this.client.ListHives())[0]?.id
            }
            catch
            {
                hiveId = undefined
            }
        }
        if (this.active !== NavSection.Releases)
        {
            return
        }
        this.Show(hiveId === undefined ? new ComingSoonView(TenantApp.LabelFor(NavSection.Releases)) : new ReleasesView(this.client, hiveId))
    }

    private ShowEnvironments(): void
    {
        const view = new EnvironmentsView(new EnvironmentsViewModel(this.client))
        view.CreateHandler = () => this.OpenCreateEnvironment(view)
        this.Show(view)
        this.environments = view
    }

    private OpenCreateEnvironment(view: EnvironmentsView): void
    {
        this.CloseDialog()
        const dialog = new CreateEnvironmentDialog(this.client, view.ExistingNames(), env => this.ShowEnvironmentDetail(env))
        dialog.AddDismissListener(() => this.CloseDialog())
        this.dialogHost.AddChild(dialog)
    }

    private CloseDialog(): void
    {
        // Neither CreateEnvironmentDialog nor Mural's Dialog exposes Dispose, so removal is the whole teardown.
        this.Clear(this.dialogHost)
    }

    private MarkEnvironmentsActive(): void
    {
        this.active = NavSection.Environments
        this.navRail.SetActive(NavSection.Environments)
    }

    private async Logout(): Promise<void>
    {
        this.Teardown()
        try
        {
            await this.client.Logout()
        }
        catch
        {
            // Fall through: drop to login regardless.
        }
        this.ShowLogin()
    }

    private Teardown(): void
    {
        this.current?.Dispose?.()
        this.current = undefined
        this.environments = undefined
        this.CloseDialog()
        this.eventUnsub?.()
        this.eventUnsub = undefined
        this.Clear(this.topHost)
        this.currentPrincipalId = ''
    }

    private OnTenantEvent(ev: TenantEvent): void
    {
        if (this.environments !== undefined)
        {
            // The environments list is the active view: ApplyEvent is its one refresh path (no extra Refresh).
            void this.environments.ApplyEvent(ev)
            return
        }
        if (ev.type === TenantEventType.EnvironmentDeleted && ev.environmentName === this.currentEnvName)
        {
            // The open environment was deleted: fall back to the environments list rather than refreshing a gone env.
            this.ShowSection(NavSection.Environments)
            return
        }
        void this.current?.Refresh()
    }

    // Swaps the content pane: disposes the outgoing view, mounts the incoming one.
    private Show(view: TenantViewBase): void
    {
        this.CloseDialog()
        this.current?.Dispose?.()
        this.Clear(this.detailHost)
        this.current = view
        this.environments = undefined
        this.currentEnvName = undefined
        view.AttachNavigator(this)
        this.detailHost.AddChild(view)
        void view.Refresh()
    }

    private Clear(host: StackPanel): void
    {
        for (const child of [...host.Children])
        {
            host.RemoveChild(child)
        }
    }
}
