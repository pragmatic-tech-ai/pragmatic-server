import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import { ComingSoonView } from './coming-soon-view.js'
import { EnvironmentDetailView } from './environment-detail-view.js'
import { HiveDetailView } from './hive-detail-view.js'
import { IdentityPlate } from './identity-plate.js'
import { NavModel, NavSection } from './nav-model.js'
import { NavRail } from './nav-rail.js'
import { TenantApiClient } from './tenant-api-client.js'
import { TenantTreeView } from './tenant-tree-view.js'
import { TenantTreeViewModel } from './tenant-tree-view-model.js'
import { TenantViewBase } from './tenant-view-base.js'
import { TenantEventType } from './tenant-types.js'
import type { EnvironmentDto, HiveDto, ITenantNavigator, ITenantView, SessionDto, TenantEvent, TenantProfileDto, AdminCapabilitiesDto } from './tenant-types.js'
import { TopBar } from './top-bar.js'
import { UserMenu } from './user-menu.js'
import { ServiceTokensView } from './service-tokens-view.js'
import { RolesPrivilegesView } from './roles-privileges-view.js'
import { FieldSecurityView } from './field-security-view.js'
import { UsersAccessHubView } from './users-access-hub-view.js'

// Root shell: auth-gated boot; a nav rail on the left, and on the right a top bar over the section content host.
export class TenantApp extends StackPanel implements ITenantNavigator
{
    public static readonly TitleText = 'Pragmatic Tenant Admin'
    // The hive name is not on the session yet (R1 fallback); shown until the session carries it.
    public static readonly HivePlaceholder = '(this hive)'

    private readonly client: TenantApiClient
    private readonly navRail: NavRail
    private readonly rightColumn = new StackPanel()
    private readonly topHost = new StackPanel()
    private readonly detailHost = new StackPanel()
    // Populated by Boot in Task 4.
    private profile: TenantProfileDto | undefined
    private current: ITenantView | undefined
    // Name of the environment the detail pane is showing, so a delete of it swaps the pane back rather than refreshing a gone env.
    private currentEnvName: string | undefined
    // Operator's principal from the Boot session; UsersAccessView uses it to guard self-disable.
    private currentPrincipalId = ''
    private active: NavSection = NavSection.Overview
    // Interim environments host: set only while the tree is the shown view.
    private tree: TenantTreeView | undefined
    private eventUnsub: (() => void) | undefined

    public constructor(client: TenantApiClient = new TenantApiClient())
    {
        super()
        this.client = client
        this.navRail = new NavRail(s => this.ShowSection(s), this.active)
        this.Orientation = Orientation.Horizontal
        this.rightColumn.Orientation = Orientation.Vertical
        this.rightColumn.AddChild(this.topHost)
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
                this.Show(new UsersAccessHubView(this.client, this.currentPrincipalId))
                break
            default:
                this.Show(new ComingSoonView(TenantApp.LabelFor(section)))
                break
        }
    }

    public ShowTree(): void
    {
        this.ShowSection(NavSection.Environments)
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

    public ShowRolesPrivileges(): void
    {
        this.Show(new RolesPrivilegesView(this.client))
    }

    public ShowFieldSecurity(): void
    {
        this.Show(new FieldSecurityView(this.client))
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
        const plate = new IdentityPlate({ tenant: session.tenantId, hive: TenantApp.HivePlaceholder })
        const userMenu = new UserMenu({ email: session.email ?? session.tenantId, onLogout: () => { void this.Logout() } })
        this.Clear(this.topHost)
        this.topHost.AddChild(new TopBar({ plate, userMenu }))
    }

    private ShowEnvironments(): void
    {
        const tree = new TenantTreeView(new TenantTreeViewModel(this.client))
        this.Show(tree)
        this.tree = tree
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
        this.tree = undefined
        this.eventUnsub?.()
        this.eventUnsub = undefined
        this.Clear(this.topHost)
        this.currentPrincipalId = ''
    }

    private OnTenantEvent(ev: TenantEvent): void
    {
        if (this.tree !== undefined)
        {
            // The interim tree is the active view: ApplyEvent is its one refresh path (no extra Refresh).
            void this.tree.ApplyEvent(ev)
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
        this.current?.Dispose?.()
        this.Clear(this.detailHost)
        this.current = view
        this.tree = undefined
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
