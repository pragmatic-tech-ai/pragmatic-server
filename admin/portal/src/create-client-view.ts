import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import type { ControlPlaneClient } from './api-client.js'
import { CreateClientViewModel } from './create-client-view-model.js'
import type { IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// Create-client form bound to CreateClientViewModel.
export class CreateClientView extends PortalViewBase
{
    public static readonly IdPlaceholder = 'Client id'
    public static readonly SubscriptionPlaceholder = 'Subscription ref (optional)'
    private static readonly HeadingText = 'New client'

    private readonly vm: CreateClientViewModel
    private readonly idBox = new TextBox()
    private readonly nameBox = new TextBox()
    private readonly subBox = new TextBox()

    public constructor(client: ControlPlaneClient, private readonly nav: IPortalNavigator)
    {
        super()
        this.vm = new CreateClientViewModel(client)
        const heading = new TextBlock()
        heading.Text = CreateClientView.HeadingText
        this.AddChild(heading)
        this.idBox.Placeholder = CreateClientView.IdPlaceholder
        this.AddChild(this.idBox)
        this.nameBox.Placeholder = PortalViewBase.DisplayNamePlaceholder
        this.AddChild(this.nameBox)
        this.subBox.Placeholder = CreateClientView.SubscriptionPlaceholder
        this.AddChild(this.subBox)
        this.AddChild(this.MakeButton(PortalViewBase.CreateLabel, () => { void this.Submit() }))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowClients() }))
        this.AddChild(this.message)
    }

    public async Refresh(): Promise<void>
    {
    }

    private async Submit(): Promise<void>
    {
        this.vm.Id = this.idBox.Text
        this.vm.DisplayName = this.nameBox.Text
        this.vm.SubscriptionRef = this.subBox.Text
        try
        {
            await this.vm.Submit()
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        this.nav.ShowClients()
    }
}
