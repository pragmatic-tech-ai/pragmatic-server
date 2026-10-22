import { StackPanel, TextBlock, Orientation } from '@pragmatic-tech-ai/mural/basic'
import type { ControlPlaneClient } from './api-client.js'
import { HiveListViewModel } from './hive-list-view-model.js'
import type { HiveDto, IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// Lists one tenant's hives with per-row Delete (inline confirm).
export class HiveListView extends PortalViewBase
{
    public static readonly NewLabel = 'New hive'
    private static readonly HeadingPrefix = 'Hives of '
    private static readonly EmptyText = 'No hives yet'

    private readonly vm: HiveListViewModel
    private readonly rows: StackPanel
    private pendingDelete: string | undefined

    public constructor(client: ControlPlaneClient, private readonly nav: IPortalNavigator, clientId: string, tenantId: string)
    {
        super()
        this.vm = new HiveListViewModel(client, tenantId)
        const heading = new TextBlock()
        heading.Text = HiveListView.HeadingPrefix + tenantId
        this.AddChild(heading)
        this.AddChild(this.MakeButton(HiveListView.NewLabel, () => { this.nav.ShowCreateHive(clientId, tenantId) }))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowTenants(clientId) }))
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
        if (this.vm.Hives.length === 0)
        {
            const empty = new TextBlock()
            empty.Text = HiveListView.EmptyText
            this.rows.AddChild(empty)
            return
        }
        for (const h of this.vm.Hives)
        {
            this.rows.AddChild(this.BuildRow(h))
        }
    }

    private BuildRow(h: HiveDto): StackPanel
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        const info = new TextBlock()
        info.Text = [h.id, h.displayName, h.cluster.backend].join(PortalViewBase.FieldSeparator)
        row.AddChild(info)
        if (this.pendingDelete === h.id)
        {
            row.AddChild(this.MakeButton(PortalViewBase.ConfirmDeleteLabel, () =>
            {
                this.pendingDelete = undefined
                void this.Run(() => this.vm.Delete(h.id))
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
                this.pendingDelete = h.id
                this.RenderRows()
            }))
        }
        return row
    }
}
