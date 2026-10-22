import { StackPanel, TextBlock, Orientation } from '@pragmatic-tech-ai/mural/basic'
import type { ControlPlaneClient } from './api-client.js'
import type { IPortalNavigator, TenantDto } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'
import { TenantListViewModel } from './tenant-list-view-model.js'

// Lists one client's tenants with per-row Delete (inline confirm).
export class TenantListView extends PortalViewBase
{
    public static readonly NewLabel = 'New tenant'
    private static readonly HeadingPrefix = 'Tenants of '
    private static readonly EmptyText = 'No tenants yet'
    private static readonly FieldSeparator = '  |  '

    private readonly vm: TenantListViewModel
    private readonly rows: StackPanel
    private pendingDelete: string | undefined

    public constructor(client: ControlPlaneClient, private readonly nav: IPortalNavigator, clientId: string)
    {
        super()
        this.vm = new TenantListViewModel(client, clientId)
        const heading = new TextBlock()
        heading.Text = TenantListView.HeadingPrefix + clientId
        this.AddChild(heading)
        this.AddChild(this.MakeButton(TenantListView.NewLabel, () => { this.nav.ShowCreateTenant(clientId) }))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowClients() }))
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
        if (this.vm.Tenants.length === 0)
        {
            const empty = new TextBlock()
            empty.Text = TenantListView.EmptyText
            this.rows.AddChild(empty)
            return
        }
        for (const t of this.vm.Tenants)
        {
            this.rows.AddChild(this.BuildRow(t))
        }
    }

    private BuildRow(t: TenantDto): StackPanel
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        const info = new TextBlock()
        info.Text = [t.id, t.displayName].join(TenantListView.FieldSeparator)
        row.AddChild(info)
        if (this.pendingDelete === t.id)
        {
            row.AddChild(this.MakeButton(PortalViewBase.ConfirmDeleteLabel, () =>
            {
                this.pendingDelete = undefined
                void this.Run(() => this.vm.Delete(t.id))
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
                this.pendingDelete = t.id
                this.RenderRows()
            }))
        }
        return row
    }
}
