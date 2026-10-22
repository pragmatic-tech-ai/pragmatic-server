import { StackPanel, TextBlock, Orientation } from '@pragmatic-tech-ai/mural/basic'
import type { ControlPlaneClient } from './api-client.js'
import { ClientListViewModel } from './client-list-view-model.js'
import type { ClientDto, IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// Lists clients with per-row Tenants / Delete (inline confirm); the master of the client -> tenant drill-down.
export class ClientListView extends PortalViewBase
{
    public static readonly NewLabel = 'New client'
    public static readonly TenantsLabel = 'Tenants'
    private static readonly HeadingText = 'Clients'
    private static readonly EmptyText = 'No clients yet'

    private readonly vm: ClientListViewModel
    private readonly rows: StackPanel
    private pendingDelete: string | undefined

    public constructor(client: ControlPlaneClient, private readonly nav: IPortalNavigator)
    {
        super()
        this.vm = new ClientListViewModel(client)
        const heading = new TextBlock()
        heading.Text = ClientListView.HeadingText
        this.AddChild(heading)
        this.AddChild(this.MakeButton(ClientListView.NewLabel, () => { this.nav.ShowCreateClient() }))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowList() }))
        this.AddChild(this.message)
        this.rows = new StackPanel()
        this.AddChild(this.rows)
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            await this.vm.Load()
            this.message.Text = PortalViewBase.NoMessage
        }
        catch (e)
        {
            this.ShowError(e)
        }
        this.RenderRows()
    }

    private RenderRows(): void
    {
        for (const child of [...this.rows.Children])
        {
            this.rows.RemoveChild(child)
        }
        if (this.vm.Clients.length === 0)
        {
            const empty = new TextBlock()
            empty.Text = ClientListView.EmptyText
            this.rows.AddChild(empty)
            return
        }
        for (const c of this.vm.Clients)
        {
            this.rows.AddChild(this.BuildRow(c))
        }
    }

    private BuildRow(c: ClientDto): StackPanel
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        const info = new TextBlock()
        info.Text = [c.id, c.displayName].join(PortalViewBase.FieldSeparator)
        row.AddChild(info)
        row.AddChild(this.MakeButton(ClientListView.TenantsLabel, () => { this.nav.ShowTenants(c.id) }))
        if (this.pendingDelete === c.id)
        {
            row.AddChild(this.MakeButton(PortalViewBase.ConfirmDeleteLabel, () =>
            {
                this.pendingDelete = undefined
                void this.Run(() => this.vm.Delete(c.id))
            }))
            row.AddChild(this.MakeButton(PortalViewBase.CancelLabel, () =>
            {
                this.pendingDelete = undefined
                this.RenderRows()
            }))
        }
        else
        {
            row.AddChild(this.MakeButton(PortalViewBase.DeleteLabel, () =>
            {
                this.pendingDelete = c.id
                this.RenderRows()
            }))
        }
        return row
    }
}
