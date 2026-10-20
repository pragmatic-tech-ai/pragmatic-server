import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import type { Visual } from '@pragmatic-tech-ai/mural/visual-engine'
import { ControlPlaneClient } from './api-client.js'
import { CreateEnvironmentView } from './create-environment-view.js'
import { EnvironmentDetailView } from './environment-detail-view.js'
import { EnvironmentListView } from './environment-list-view.js'
import { CreateGraphView } from './create-graph-view.js'
import { MakerTokenView } from './maker-token-view.js'
import { PromoteGraphView } from './promote-graph-view.js'
import { GraphListView } from './graph-list-view.js'
import { LoginView } from './login-view.js'
import { RoleConfigView } from './role-config-view.js'
import { ManageView } from './manage-view.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'

// Root shell: owns the API client, switches list / create / detail, and
// refreshes the current screen when the events socket reports a change.
export class App extends StackPanel implements IPortalNavigator
{
    public static readonly TitleText = 'Pragmatic Admin'
    public static readonly LogoutLabel = 'Logout'

    private readonly client = new ControlPlaneClient()
    private readonly host = new StackPanel()
    private readonly header = new StackPanel()
    private readonly logoutButton: Button
    private logoutShown = false
    private current: (Visual & IPortalView) | undefined

    public constructor()
    {
        super()
        const title = new TextBlock()
        title.Text = App.TitleText
        this.header.Orientation = Orientation.Horizontal
        this.header.AddChild(title)
        const logoutText = new TextBlock()
        logoutText.Text = App.LogoutLabel
        this.logoutButton = new Button()
        this.logoutButton.Content = logoutText
        this.logoutButton.AddClickHandler(() => { void this.Logout() })
        this.AddChild(this.header)
        this.AddChild(this.host)
        this.client.OnChanged(() => { void this.current?.Refresh() })
        void this.Boot()
    }

    // Probes the session cookie: signed in -> list, otherwise -> login.
    private async Boot(): Promise<void>
    {
        let operator: { email: string } | null = null
        try
        {
            operator = await this.client.Session()
        }
        catch
        {
            // Session probe failed (network/server error): fall back to the login view.
            operator = null
        }
        if (operator === null)
        {
            this.ShowLogin()
        }
        else
        {
            this.ShowList()
        }
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

    public ShowLogin(): void
    {
        if (this.current instanceof LoginView)
        {
            return
        }
        this.SetLogoutVisible(false)
        this.Show(new LoginView(this.client, this))
    }

    private SetLogoutVisible(visible: boolean): void
    {
        const present = this.logoutShown
        if (visible && !present)
        {
            this.header.AddChild(this.logoutButton)
            this.logoutShown = true
        }
        else if (!visible && present)
        {
            this.header.RemoveChild(this.logoutButton)
            this.logoutShown = false
        }
    }

    public ShowList(): void
    {
        this.SetLogoutVisible(true)
        this.Show(new EnvironmentListView(this.client, this))
    }

    public ShowCreate(): void
    {
        this.SetLogoutVisible(true)
        this.Show(new CreateEnvironmentView(this.client, this))
    }

    public ShowDetail(name: string): void
    {
        this.SetLogoutVisible(true)
        this.Show(new EnvironmentDetailView(this.client, this, name))
    }

    public ShowManage(name: string): void
    {
        this.SetLogoutVisible(true)
        this.Show(new ManageView(this.client, this, name))
    }

    public ShowRoles(name: string): void
    {
        this.SetLogoutVisible(true)
        this.Show(new RoleConfigView(this.client, this, name))
    }

    public ShowGraphs(name: string): void
    {
        this.SetLogoutVisible(true)
        this.Show(new GraphListView(this.client, this, name))
    }

    public ShowCreateGraph(name: string): void
    {
        this.SetLogoutVisible(true)
        this.Show(new CreateGraphView(this.client, this, name))
    }

    public ShowPromoteGraph(devEnvName: string): void
    {
        this.SetLogoutVisible(true)
        this.Show(new PromoteGraphView(this.client, this, devEnvName))
    }

    public ShowMakerToken(envName: string): void
    {
        this.SetLogoutVisible(true)
        this.Show(new MakerTokenView(this.client, this, envName))
    }

    private Show(view: Visual & IPortalView): void
    {
        for (const child of [...this.host.Children])
        {
            this.host.RemoveChild(child)
        }
        this.current = view
        view.AttachNavigator(this)
        this.host.AddChild(view)
        void view.Refresh()
    }
}
