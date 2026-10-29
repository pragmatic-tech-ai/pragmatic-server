import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { ClientDetailView } from './client-detail-view.js'
import { ClientDetailViewModel } from './client-detail-view-model.js'
import { ClientsViewModel } from './clients-view-model.js'
import type { ClientListRow } from './clients-view-model.js'
import { CreateClientViewModel } from './create-client-view-model.js'
import { Act, ActVariant, KeyActivatedButton, PageHeader, Section } from './kit/index.js'
import type { TableColumn } from './kit/index.js'
import { OperatorContext } from './operator-context.js'
import type { ClientDto } from './portal-types.js'
import { ProvisionWizardView } from './provision-wizard-view.js'
import { SectionContainerView, SectionState } from './section-container-view.js'
import type { SectionLabels } from './section-container-view.js'

export enum ClientsMode
{
    List,
    Create,
    Detail,
}

// Clients section: a self-routing container (list / detail) with a localized Create form as the
// base's Custom state.
export class ClientsView extends SectionContainerView<ClientListRow>
{
    private static readonly ListBreadcrumb: readonly string[] = ['Provisioning', 'Clients']
    private static readonly CreateBreadcrumb: readonly string[] = ['Clients', 'New client']
    private static readonly ListTitle = 'Clients'
    private static readonly CreateTitle = 'New client'
    private static readonly CreateActionLabel = 'Create client'
    private static readonly ProvisionActionLabel = 'Provision customer'
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
    private static readonly BlankText = ''
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

    private model: ClientsViewModel | undefined
    private createAction: Act | undefined
    private provisionAction: Act | undefined
    private wizardScreen: ProvisionWizardView | undefined
    private errorText: TextBlock | undefined
    private submitAction: Act | undefined
    private readonly createModel: CreateClientViewModel

    public constructor(private readonly client: ControlPlaneClient, private readonly operator: OperatorContext)
    {
        super()
        this.createModel = new CreateClientViewModel(client)
    }

    public get Mode(): ClientsMode
    {
        return this.State === SectionState.Custom
            ? ClientsMode.Create
            : this.State === SectionState.Detail ? ClientsMode.Detail : ClientsMode.List
    }

    public get CreateAction(): Act | undefined
    {
        return this.createAction
    }

    // Test seam: the create form's submit action.
    public get SubmitAction(): Act | undefined
    {
        return this.submitAction
    }

    // Test seam: the Provision customer action (visible-but-disabled for an Observer).
    public get ProvisionAction(): Act | undefined
    {
        return this.provisionAction
    }

    // Test seam: the provisioning wizard while it is the swapped-in screen.
    public get WizardScreen(): ProvisionWizardView | undefined
    {
        return this.wizardScreen
    }

    // Wizard completion / cancel: drop the finished wizard (it held the one-time secrets in its
    // reveal Visuals) before returning to the list.
    public ReturnFromWizard(): void
    {
        this.wizardScreen = undefined
        void this.ShowList()
    }

    public ShowCreate(): void
    {
        this.EnterCustom()
        this.SwapScreen(this.BuildCreate())
    }

    protected Labels(): SectionLabels
    {
        return {
            listBreadcrumb: ClientsView.ListBreadcrumb,
            listTitle: ClientsView.ListTitle,
            emptyTitle: ClientsView.EmptyTitle,
            errorTitle: ClientsView.ErrorTitle,
            tableEmptyText: ClientsView.TableEmptyText,
        }
    }

    protected SearchText(row: ClientListRow): string
    {
        return row.displayName + ClientsView.SearchSeparator + row.id
    }

    protected async LoadRows(): Promise<readonly ClientListRow[]>
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
        return this.model.Rows
    }

    protected async BuildDetail(row: ClientListRow): Promise<Visual | undefined>
    {
        const dto: ClientDto = { id: row.id, displayName: row.displayName, subscriptionRef: row.subscriptionRef, createdAt: row.createdAt }
        const [tenants, fleet] = await Promise.all([this.client.ListTenants(row.id), this.client.ListFleet()])
        return new ClientDetailView(new ClientDetailViewModel(dto, tenants, fleet), () => void this.ShowList())
    }

    // Called on every render and an Act holds one parent, so build a fresh Act each time.
    protected ListPrimaryAction(): Act | undefined
    {
        this.createAction = new Act(this.operator.MutatingAct(ClientsView.CreateActionLabel, () => this.ShowCreate()))
        return this.createAction
    }

    protected ListSecondaryAction(): Act | undefined
    {
        this.provisionAction = new Act(this.operator.MutatingAct(ClientsView.ProvisionActionLabel, () => this.ShowProvision()))
        return this.provisionAction
    }

    private ShowProvision(): void
    {
        this.EnterCustom()
        this.wizardScreen = new ProvisionWizardView(this.client, this.operator, () => this.ReturnFromWizard())
        this.SwapScreen(this.wizardScreen)
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
        this.submitAction = submit
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
        if (this.errorText !== undefined)
        {
            this.errorText.Text = ClientsView.BlankText
        }
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

    protected Columns(): TableColumn<ClientListRow>[]
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
                cell: r => ClientDetailViewModel.ClientSinceLabel(r.createdAt),
            },
        ]
    }
}
