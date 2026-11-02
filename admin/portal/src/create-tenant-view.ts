import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ComboBox } from '@pragmatic-tech-ai/mural/framework'
import { CreateTenantViewModel } from './create-tenant-view-model.js'
import type { ICreateTenantSource } from './create-tenant-view-model.js'
import type { ClientDto, CreatedTenantDto, IPortalNavigator } from './portal-types.js'
import { ComboOption, OnceSecret } from './kit/index.js'
import { PortalViewBase } from './portal-view-base.js'

// Create-tenant form: client dropdown (from ListClients), id, display name, owner email.
// Creating a tenant provisions its Owner; the one-time Owner password is revealed here once,
// and the view only leaves after the operator confirms it was saved.
export class CreateTenantView extends PortalViewBase
{
    public static readonly IdPlaceholder = 'Tenant id (lowercase a-z, 0-9, -)'
    public static readonly ClientPlaceholder = 'Client'
    public static readonly OwnerEmailPlaceholder = 'Owner email'
    private static readonly HeadingText = 'New tenant'
    private static readonly LabelPath = 'Label'
    private static readonly NoClient = 'Choose a client'
    private static readonly RevealIntro = 'Tenant created. The Owner password below is shown once and cannot be retrieved later. Save it, then confirm.'
    private static readonly OwnerPasswordLabelPrefix = 'Owner password for '
    private static readonly OwnerConfirmLabel = 'I saved the Owner password'

    private readonly vm: CreateTenantViewModel
    private readonly clientBox = new ComboBox()
    private readonly idBox = new TextBox()
    private readonly nameBox = new TextBox()
    private readonly ownerBox = new TextBox()
    private reveal: OnceSecret | undefined

    public constructor(source: ICreateTenantSource, private readonly nav: IPortalNavigator, private readonly initialClientId: string)
    {
        super()
        this.vm = new CreateTenantViewModel(source, initialClientId)
        const heading = new TextBlock()
        heading.Text = CreateTenantView.HeadingText
        this.AddChild(heading)
        this.clientBox.Placeholder = CreateTenantView.ClientPlaceholder
        this.clientBox.DisplayMemberPath = CreateTenantView.LabelPath
        this.AddChild(this.clientBox)
        this.idBox.Placeholder = CreateTenantView.IdPlaceholder
        this.AddChild(this.idBox)
        this.nameBox.Placeholder = PortalViewBase.DisplayNamePlaceholder
        this.AddChild(this.nameBox)
        this.ownerBox.Placeholder = CreateTenantView.OwnerEmailPlaceholder
        this.AddChild(this.ownerBox)
        this.AddChild(this.MakeButton(PortalViewBase.CreateLabel, () => { void this.Submit() }))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.GoBack() }))
        this.AddChild(this.message)
    }

    // Test seam: the tenant id field.
    public get IdBox(): TextBox
    {
        return this.idBox
    }

    // Test seam: the display name field.
    public get NameBox(): TextBox
    {
        return this.nameBox
    }

    // Test seam: the owner email field.
    public get OwnerBox(): TextBox
    {
        return this.ownerBox
    }

    // Test seam: the one-time Owner password reveal, present only after a successful create.
    public get Reveal(): OnceSecret | undefined
    {
        return this.reveal
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
        const options = this.vm.Clients.map((c: ClientDto) => new ComboOption(c.displayName, c.id))
        this.clientBox.ItemsSource = options
        const index = options.findIndex(o => o.Value === this.vm.ClientId)
        if (index >= 0)
        {
            this.clientBox.SelectedIndex = index
        }
    }

    public async Submit(): Promise<void>
    {
        const selected = this.clientBox.SelectedItem as ComboOption | undefined
        if (selected === undefined)
        {
            this.message.Text = PortalViewBase.ErrorPrefix + CreateTenantView.NoClient
            return
        }
        this.vm.ClientId = selected.Value
        this.vm.Id = this.idBox.Text
        this.vm.DisplayName = this.nameBox.Text
        this.vm.OwnerEmail = this.ownerBox.Text
        let created: CreatedTenantDto
        try
        {
            created = await this.vm.Submit()
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        this.ShowReveal(created, selected.Value)
    }

    // Replaces the form with the one-time reveal; the password lives only in the OnceSecret Visual.
    private ShowReveal(created: CreatedTenantDto, clientId: string): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
        const intro = new TextBlock()
        intro.Text = CreateTenantView.RevealIntro
        this.AddChild(intro)
        this.reveal = new OnceSecret({
            label: CreateTenantView.OwnerPasswordLabelPrefix + created.owner.email,
            value: created.owner.password,
            confirmLabel: CreateTenantView.OwnerConfirmLabel,
            onConfirm: () => { this.nav.ShowTenants(clientId) },
        })
        this.AddChild(this.reveal)
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
}
