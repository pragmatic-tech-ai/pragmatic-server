import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { ClientDetailView } from './client-detail-view.js'
import { ClientDetailViewModel } from './client-detail-view-model.js'
import { ClientsViewModel } from './clients-view-model.js'
import type { ClientListRow } from './clients-view-model.js'
import { CreateClientViewModel } from './create-client-view-model.js'
import {
    Act, ActVariant, DataTable, KeyActivatedButton, PageHeader, ScreenHost, Section, TableDensity,
} from './kit/index.js'
import type { ScreenHostInputs, TableColumn } from './kit/index.js'
import { OperatorContext } from './operator-context.js'
import type { ClientDto, IPortalNavigator, IPortalView } from './portal-types.js'

export enum ClientsMode
{
    List,
    Create,
    Detail,
}

// Clients section: a self-routing container (list / create / detail). Every screen swap clears the
// content host and adds a freshly built screen, since a Visual may hold only one parent.
export class ClientsView extends StackPanel implements IPortalView
{
    private static readonly ListBreadcrumb: readonly string[] = ['Provisioning', 'Clients']
    private static readonly CreateBreadcrumb: readonly string[] = ['Clients', 'New client']
    private static readonly ListTitle = 'Clients'
    private static readonly CreateTitle = 'New client'
    private static readonly CreateActionLabel = 'Create client'
    private static readonly SubmitLabel = 'Create'
    private static readonly CancelLabel = 'Cancel'
    private static readonly IdPlaceholder = 'Client id'
    private static readonly NamePlaceholder = 'Display name'
    private static readonly SubscriptionPlaceholder = 'Subscription ref (optional)'
    private static readonly FormTitle = 'Client details'
    private static readonly EmptyTitle = 'No clients yet. Create the first client to start onboarding.'
    private static readonly ErrorTitle = 'Could not load the clients.'
    private static readonly TableEmptyText = 'No clients match.'
    private static readonly SearchSeparator = ' '
    private static readonly NoneText = '-'
    private static readonly DateLength = 10
    private static readonly ClientKey = 'client'
    private static readonly TenantsKey = 'tenants'
    private static readonly HivesKey = 'hives'
    private static readonly SubscriptionKey = 'subscription'
    private static readonly SinceKey = 'since'
    private static readonly ClientHeader = 'Client'
    private static readonly TenantsHeader = 'Tenants'
    private static readonly HivesHeader = 'Hives'
    private static readonly SubscriptionHeader = 'Subscription'
    private static readonly SinceHeader = 'Client since'

    private readonly content = new StackPanel()
    private host: ScreenHost
    private listSlot = new StackPanel()
    private model: ClientsViewModel | undefined
    private createAction: Act | undefined
    private mode = ClientsMode.List
    private listMounted = true
    private detailRow: ClientListRow | undefined
    private nav: IPortalNavigator | undefined
    private errorText: TextBlock | undefined
    private readonly createModel: CreateClientViewModel

    public constructor(private readonly client: ControlPlaneClient, private readonly operator: OperatorContext)
    {
        super()
        this.Orientation = Orientation.Vertical
        this.content.Orientation = Orientation.Vertical
        this.createModel = new CreateClientViewModel(client)
        this.host = new ScreenHost(ClientsView.Inputs(true, false, true))
        this.AddChild(this.content)
        this.content.AddChild(this.host)
    }

    // Test seam: the list screen's host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the list table (populated list only).
    public get Table(): DataTable<ClientListRow> | undefined
    {
        const child = [...this.listSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<ClientListRow> : undefined
    }

    public get Mode(): ClientsMode
    {
        return this.mode
    }

    public get CreateAction(): Act | undefined
    {
        return this.createAction
    }

    public AttachNavigator(nav: IPortalNavigator): void
    {
        this.nav = nav
    }

    public async Refresh(): Promise<void>
    {
        if (this.mode === ClientsMode.Detail && this.detailRow !== undefined)
        {
            await this.ShowDetail(this.detailRow)
        }
        else if (this.mode === ClientsMode.List)
        {
            await this.ShowList()
        }
    }

    public async ShowList(): Promise<void>
    {
        if (!this.listMounted)
        {
            this.host = new ScreenHost(ClientsView.Inputs(true, false, true))
            this.Swap(this.host)
            this.listMounted = true
        }
        this.mode = ClientsMode.List
        this.detailRow = undefined
        if (this.model === undefined)
        {
            this.host.Update(ClientsView.Inputs(true, false, true))
        }
        try
        {
            const [clients, tenants, fleet] = await Promise.all([
                this.client.ListClients(), this.client.ListTenants(), this.client.ListFleet(),
            ])
            if (this.model === undefined)
            {
                this.model = new ClientsViewModel(clients, tenants, fleet)
            }
            else
            {
                this.model.Update(clients, tenants, fleet)
            }
        }
        catch
        {
            this.host.Update(ClientsView.Inputs(false, true, true))
            return
        }
        const model = this.model
        this.host.Update(ClientsView.Inputs(false, false, model.Rows.length === 0, () => this.BuildList(model)))
    }

    public ShowCreate(): void
    {
        this.mode = ClientsMode.Create
        this.listMounted = false
        this.Swap(this.BuildCreate())
    }

    public async ShowDetail(row: ClientListRow): Promise<void>
    {
        this.mode = ClientsMode.Detail
        this.detailRow = row
        const dto: ClientDto = { id: row.id, displayName: row.displayName, subscriptionRef: row.subscriptionRef, createdAt: row.createdAt }
        const [tenants, fleet] = await Promise.all([this.client.ListTenants(row.id), this.client.ListFleet()])
        if (this.mode !== ClientsMode.Detail || this.detailRow !== row)
        {
            return
        }
        this.listMounted = false
        this.Swap(new ClientDetailView(new ClientDetailViewModel(dto, tenants, fleet), () => void this.ShowList()))
    }

    private static Inputs(loading: boolean, error: boolean, isEmpty: boolean, content?: () => Visual): ScreenHostInputs
    {
        return {
            loading,
            allowed: true,
            error,
            isEmpty,
            empty: { title: ClientsView.EmptyTitle },
            errorConfig: { title: ClientsView.ErrorTitle },
            content,
        }
    }

    private Swap(screen: Visual): void
    {
        for (const child of [...this.content.Children])
        {
            this.content.RemoveChild(child)
        }
        this.content.AddChild(screen)
    }

    private BuildList(model: ClientsViewModel): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        this.createAction = new Act(this.operator.MutatingAct(ClientsView.CreateActionLabel, () => this.ShowCreate()))
        root.AddChild(new PageHeader({
            breadcrumb: ClientsView.ListBreadcrumb,
            title: ClientsView.ListTitle,
            primaryAction: this.createAction,
        }))
        // Fresh slot per render: the previous one is still parented to the previous root.
        this.listSlot = new StackPanel()
        this.listSlot.Orientation = Orientation.Vertical
        this.listSlot.AddChild(new DataTable<ClientListRow>({
            columns: ClientsView.Columns(),
            rows: model.Rows,
            density: TableDensity.Dense,
            searchText: r => r.displayName + ClientsView.SearchSeparator + r.id,
            onOpen: r => void this.ShowDetail(r),
            emptyText: ClientsView.TableEmptyText,
        }))
        root.AddChild(this.listSlot)
        return root
    }

    private BuildCreate(): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(new PageHeader({ breadcrumb: ClientsView.CreateBreadcrumb, title: ClientsView.CreateTitle }))
        const idBox = ClientsView.Box(ClientsView.IdPlaceholder)
        const nameBox = ClientsView.Box(ClientsView.NamePlaceholder)
        const subBox = ClientsView.Box(ClientsView.SubscriptionPlaceholder)
        const errorText = new TextBlock()
        this.errorText = errorText
        const submit = new Act(this.operator.MutatingAct(
            ClientsView.SubmitLabel,
            () => void this.Submit(idBox.Text, nameBox.Text, subBox.Text),
            ActVariant.Primary,
        ))
        const cancel = new KeyActivatedButton(() => void this.ShowList())
        const cancelText = new TextBlock()
        cancelText.Text = ClientsView.CancelLabel
        cancel.Content = cancelText
        const body = new StackPanel()
        body.Orientation = Orientation.Vertical
        body.AddChild(idBox)
        body.AddChild(nameBox)
        body.AddChild(subBox)
        body.AddChild(errorText)
        body.AddChild(submit)
        body.AddChild(cancel)
        root.AddChild(new Section({ title: ClientsView.FormTitle, body }))
        return root
    }

    private static Box(placeholder: string): TextBox
    {
        const box = new TextBox()
        box.Placeholder = placeholder
        return box
    }

    private async Submit(id: string, displayName: string, subscriptionRef: string): Promise<void>
    {
        this.createModel.Id = id
        this.createModel.DisplayName = displayName
        this.createModel.SubscriptionRef = subscriptionRef
        try
        {
            await this.createModel.Submit()
        }
        catch (e)
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = e instanceof Error ? e.message : String(e)
            }
            return
        }
        await this.ShowList()
    }

    private static Columns(): TableColumn<ClientListRow>[]
    {
        return [
            {
                key: ClientsView.ClientKey,
                header: ClientsView.ClientHeader,
                cell: r => r.displayName,
                sort: (a, b) => a.displayName.localeCompare(b.displayName),
            },
            {
                key: ClientsView.TenantsKey,
                header: ClientsView.TenantsHeader,
                cell: r => String(r.tenantCount),
                sort: (a, b) => a.tenantCount - b.tenantCount,
            },
            { key: ClientsView.HivesKey, header: ClientsView.HivesHeader, cell: r => r.connectionSummary },
            {
                key: ClientsView.SubscriptionKey,
                header: ClientsView.SubscriptionHeader,
                cell: r => r.subscriptionRef ?? ClientsView.NoneText,
            },
            {
                key: ClientsView.SinceKey,
                header: ClientsView.SinceHeader,
                cell: r => r.createdAt.slice(0, ClientsView.DateLength),
            },
        ]
    }
}
