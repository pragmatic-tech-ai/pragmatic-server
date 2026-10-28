import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/visual-engine'
import { ControlPlaneClient } from './api-client.js'
import { EnvironmentDetailView } from './environment-detail-view.js'
import { EnvironmentListView } from './environment-list-view.js'
import { CreateGraphView } from './create-graph-view.js'
import { PromoteGraphView } from './promote-graph-view.js'
import { GraphListView } from './graph-list-view.js'
import { LoginView } from './login-view.js'
import { ClientListView } from './client-list-view.js'
import { CreateClientView } from './create-client-view.js'
import { TenantListView } from './tenant-list-view.js'
import { CreateTenantView } from './create-tenant-view.js'
import { HiveListView } from './hive-list-view.js'
import { CreateHiveView } from './create-hive-view.js'
import type { IPortalNavigator, IPortalView, OperatorDto } from './portal-types.js'

import { ComingSoonView } from './coming-soon-view.js'
import { FleetView } from './fleet-view.js'
import { NavModel, PaSection } from './nav-model.js'
import { NavRail } from './nav-rail.js'
import { TopBar } from './top-bar.js'
import { Banner, BannerTone } from './kit/index.js'
import { OperatorContext } from './operator-context.js'

// Root shell: grouped nav rail + top bar around a content host. Owns the API client, routes the nine
// sections to placeholders, keeps the legacy drill-down reachable via a dev-only entry, and refreshes
// the current screen when the events socket reports a change.
export class App extends StackPanel implements IPortalNavigator
{
    // Retained for the legacy e2e spec (portal.spec.ts, PA-15 owns its update); the shell brand lives in NavRail.
    public static readonly TitleText = 'Pragmatic Admin'
    public static readonly LogoutLabel = 'Logout'
    private static readonly ContextText = 'Platform'
    private static readonly ObserverNoticeText = 'Observer - read-only. You can view everything here; actions need the Operator role.'

    private readonly client: ControlPlaneClient
    private readonly navColumn = new StackPanel()
    private readonly rightColumn = new StackPanel()
    private readonly topHost = new StackPanel()
    private readonly contentHost = new StackPanel()
    private navRail: NavRail | undefined
    private topBar: TopBar | undefined
    private shellShown = false
    private operator: OperatorContext | undefined
    private active: PaSection | undefined
    private current: (Visual & IPortalView) | undefined

    public constructor(client: ControlPlaneClient = new ControlPlaneClient(), autoBoot = true)
    {
        super()
        this.client = client
        this.Orientation = Orientation.Horizontal
        this.navColumn.Orientation = Orientation.Vertical
        this.rightColumn.Orientation = Orientation.Vertical
        this.rightColumn.AddChild(this.topHost)
        this.rightColumn.AddChild(this.contentHost)
        this.AddChild(this.rightColumn)
        this.client.OnChanged(() => { void this.current?.Refresh?.() })
        if (autoBoot)
        {
            void this.Boot()
        }
    }

    public get ActiveSection(): PaSection | undefined
    {
        return this.active
    }

    public get CurrentView(): IPortalView | undefined
    {
        return this.current
    }

    // Test seam: the nav rail while signed in, otherwise undefined.
    public get Nav(): NavRail | undefined
    {
        return this.shellShown ? this.navRail : undefined
    }

    // Test seam: the top bar while signed in, otherwise undefined.
    public get Top(): TopBar | undefined
    {
        return this.shellShown ? this.topBar : undefined
    }

    // Test/screen seam: the signed-in operator's capability, otherwise undefined.
    public get Operator(): OperatorContext | undefined
    {
        return this.shellShown ? this.operator : undefined
    }

    // Probes the session cookie: signed in -> Fleet in the shell, otherwise -> login.
    public async Boot(): Promise<void>
    {
        let session: OperatorDto | null = null
        try
        {
            session = await this.client.Session()
        }
        catch
        {
            // Session probe failed (network/server error): fall back to the login view.
            session = null
        }
        if (session === null)
        {
            this.ShowLogin()
            return
        }
        this.MountShell(session.email, OperatorContext.FromWire(session.role))
        this.ShowSection(PaSection.Fleet)
        this.navRail?.FocusActive()
    }

    public ShowSection(section: PaSection): void
    {
        this.active = section
        this.navRail?.SetActive(section)
        if (section === PaSection.Fleet)
        {
            this.Mount(new FleetView(this.client))
            return
        }
        const label = NavModel.LabelFor(section)
        const heading = App.HeadingFor(section)
        const breadcrumb = heading === undefined ? [label] : [heading, label]
        this.Mount(new ComingSoonView(breadcrumb, label))
    }

    public ShowLogin(): void
    {
        if (this.current instanceof LoginView)
        {
            return
        }
        this.UnmountShell()
        this.Mount(new LoginView(this.client, this))
    }

    private async Logout(): Promise<void>
    {
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

    private static HeadingFor(section: PaSection): string | undefined
    {
        for (const group of NavModel.Groups)
        {
            for (const item of group.items)
            {
                if (item.Section === section)
                {
                    return group.heading
                }
            }
        }
        return undefined
    }

    private MountShell(operatorEmail: string, operator: OperatorContext): void
    {
        this.UnmountShell()
        this.operator = operator
        this.navRail = new NavRail(s => this.ShowSection(s), this.active)
        this.topBar = new TopBar({
            context: App.ContextText,
            onJump: s => this.ShowSection(s),
            onLogout: () => { void this.Logout() },
            onLegacy: () => this.ShowList(),
            operatorEmail,
            roleLabel: operator.RoleLabel,
        })
        if (!operator.CanMutate)
        {
            this.topBar.BannerSlot.AddChild(new Banner({ tone: BannerTone.Info, text: App.ObserverNoticeText }))
        }
        this.navColumn.AddChild(this.navRail)
        this.topHost.AddChild(this.topBar)
        // Nav sits left of the right column: rebuild the root children in order.
        this.RemoveChild(this.rightColumn)
        this.AddChild(this.navColumn)
        this.AddChild(this.rightColumn)
        this.shellShown = true
    }

    private UnmountShell(): void
    {
        if (!this.shellShown)
        {
            return
        }
        for (const child of [...this.navColumn.Children])
        {
            this.navColumn.RemoveChild(child)
        }
        for (const child of [...this.topHost.Children])
        {
            this.topHost.RemoveChild(child)
        }
        this.RemoveChild(this.navColumn)
        this.navRail = undefined
        this.topBar = undefined
        this.operator = undefined
        this.shellShown = false
    }

    public ShowList(): void
    {
        this.Mount(new EnvironmentListView(this.client, this))
    }

    public ShowDetail(name: string): void
    {
        this.Mount(new EnvironmentDetailView(this.client, this, name))
    }

    public ShowGraphs(name: string): void
    {
        this.Mount(new GraphListView(this.client, this, name))
    }

    public ShowCreateGraph(name: string): void
    {
        this.Mount(new CreateGraphView(this.client, this, name))
    }

    public ShowPromoteGraph(devEnvName: string): void
    {
        this.Mount(new PromoteGraphView(this.client, this, devEnvName))
    }

    public ShowClients(): void
    {
        this.Mount(new ClientListView(this.client, this))
    }

    public ShowCreateClient(): void
    {
        this.Mount(new CreateClientView(this.client, this))
    }

    public ShowTenants(clientId: string): void
    {
        this.Mount(new TenantListView(this.client, this, clientId))
    }

    public ShowCreateTenant(clientId: string): void
    {
        this.Mount(new CreateTenantView(this.client, this, clientId))
    }

    public ShowHives(clientId: string, tenantId: string): void
    {
        this.Mount(new HiveListView(this.client, this, clientId, tenantId))
    }

    public ShowCreateHive(clientId: string, tenantId: string): void
    {
        this.Mount(new CreateHiveView(this.client, this, clientId, tenantId))
    }

    private Mount(view: Visual & IPortalView): void
    {
        for (const child of [...this.contentHost.Children])
        {
            this.contentHost.RemoveChild(child)
        }
        this.current = view
        view.AttachNavigator(this)
        this.contentHost.AddChild(view)
        void view.Refresh()
    }
}
