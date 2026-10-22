import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ComboBox } from '@pragmatic-tech-ai/mural/framework'
import type { ControlPlaneClient } from './api-client.js'
import { CreateTenantViewModel } from './create-tenant-view-model.js'
import type { ClientDto, IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// ComboBox item: the collapsed selection renders Label; Id is the client id.
export class ClientOption
{
    public constructor(public readonly Label: string, public readonly Id: string)
    {
    }
}

// Create-tenant form: client dropdown (from ListClients), id, display name.
export class CreateTenantView extends PortalViewBase
{
    public static readonly CreateLabel = 'Create'
    public static readonly IdPlaceholder = 'Tenant id'
    public static readonly DisplayNamePlaceholder = 'Display name'
    public static readonly ClientPlaceholder = 'Client'
    private static readonly HeadingText = 'New tenant'
    private static readonly LabelPath = 'Label'
    private static readonly NoClient = 'Choose a client'

    private readonly vm: CreateTenantViewModel
    private readonly clientBox = new ComboBox()
    private readonly idBox = new TextBox()
    private readonly nameBox = new TextBox()

    public constructor(client: ControlPlaneClient, private readonly nav: IPortalNavigator, private readonly initialClientId: string)
    {
        super()
        this.vm = new CreateTenantViewModel(client, initialClientId)
        const heading = new TextBlock()
        heading.Text = CreateTenantView.HeadingText
        this.AddChild(heading)
        this.clientBox.Placeholder = CreateTenantView.ClientPlaceholder
        this.clientBox.DisplayMemberPath = CreateTenantView.LabelPath
        this.AddChild(this.clientBox)
        this.idBox.Placeholder = CreateTenantView.IdPlaceholder
        this.AddChild(this.idBox)
        this.nameBox.Placeholder = CreateTenantView.DisplayNamePlaceholder
        this.AddChild(this.nameBox)
        this.AddChild(this.MakeButton(CreateTenantView.CreateLabel, () => { void this.Submit() }))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.GoBack() }))
        this.AddChild(this.message)
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            await this.vm.Load()
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        const options = this.vm.Clients.map((c: ClientDto) => new ClientOption(c.displayName, c.id))
        this.clientBox.ItemsSource = options
        const index = options.findIndex(o => o.Id === this.vm.ClientId)
        if (index >= 0)
        {
            this.clientBox.SelectedIndex = index
        }
    }

    private GoBack(): void
    {
        if (this.initialClientId.length > 0)
        {
            this.nav.ShowTenants(this.initialClientId)
        }
        else
        {
            this.nav.ShowClients()
        }
    }

    private async Submit(): Promise<void>
    {
        const selected = this.clientBox.SelectedItem as ClientOption | undefined
        if (selected === undefined)
        {
            this.message.Text = PortalViewBase.ErrorPrefix + CreateTenantView.NoClient
            return
        }
        this.vm.ClientId = selected.Id
        this.vm.Id = this.idBox.Text
        this.vm.DisplayName = this.nameBox.Text
        try
        {
            await this.vm.Submit()
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        this.nav.ShowTenants(selected.Id)
    }
}
