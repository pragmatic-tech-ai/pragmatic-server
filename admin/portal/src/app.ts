import { StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/visual-engine'
import { ControlPlaneClient } from './api-client.js'
import { CreateEnvironmentView } from './create-environment-view.js'
import { EnvironmentDetailView } from './environment-detail-view.js'
import { EnvironmentListView } from './environment-list-view.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'

// Root shell: owns the API client, switches list / create / detail, and
// refreshes the current screen when the events socket reports a change.
export class App extends StackPanel implements IPortalNavigator
{
    public static readonly TitleText = 'Pragmatic Admin'

    private readonly client = new ControlPlaneClient()
    private readonly host = new StackPanel()
    private current: (Visual & IPortalView) | undefined

    public constructor()
    {
        super()
        const title = new TextBlock()
        title.Text = App.TitleText
        this.AddChild(title)
        this.AddChild(this.host)
        this.client.OnChanged(() => { void this.current?.Refresh() })
        this.ShowList()
    }

    public ShowList(): void
    {
        this.Show(new EnvironmentListView(this.client, this))
    }

    public ShowCreate(): void
    {
        this.Show(new CreateEnvironmentView(this.client, this))
    }

    public ShowDetail(name: string): void
    {
        this.Show(new EnvironmentDetailView(this.client, this, name))
    }

    private Show(view: Visual & IPortalView): void
    {
        for (const child of [...this.host.Children])
        {
            this.host.RemoveChild(child)
        }
        this.current = view
        this.host.AddChild(view)
        void view.Refresh()
    }
}
