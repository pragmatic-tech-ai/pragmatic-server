import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import type { CreatedTenantDto } from '../../portal-types.js'
import { OptionViewModel } from '../../shell/option-view-model.js'
import { PortalDialogViewModel } from '../../shell/portal-dialog-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'

// Create tenant: the owning client, the tenant id and display name, and the
// email of the tenant's first Owner. The result carries the Owner's one-time
// password; this dialog hands it on and keeps no copy.
export class NewTenantDialogViewModel extends PortalDialogViewModel<CreatedTenantDto>
{
    private static readonly SelectedClientProperty = 'SelectedClient'
    private static readonly IdProperty = 'Id'
    private static readonly IdErrorTextProperty = 'IdErrorText'
    private static readonly DisplayNameProperty = 'DisplayName'
    private static readonly OwnerEmailProperty = 'OwnerEmail'
    private static readonly IdPattern = /^[a-z0-9-]+$/
    private static readonly IdErrorMessage = 'Use lowercase letters a-z, digits 0-9 and -.'
    private static readonly EmailMark = '@'

    private readonly clients = new ObservableCollection<OptionViewModel<string>>()
    private selectedClient: OptionViewModel<string> | undefined
    private id = ''
    private displayName = ''
    private ownerEmail = ''

    public constructor(session: PortalSessionService, dialogs: DialogService)
    {
        super(session, dialogs)
    }

    // Fills the client choices (by display name).
    public override async Load(): Promise<void>
    {
        const clients = await this.Session.Client.ListClients()
        this.clients.Clear()
        for (const client of clients)
        {
            this.clients.Add(new OptionViewModel(client.id, client.displayName))
        }
    }

    public get Clients(): ObservableCollection<OptionViewModel<string>>
    {
        return this.clients
    }

    public get SelectedClient(): OptionViewModel<string> | undefined
    {
        return this.selectedClient
    }

    public set SelectedClient(value: OptionViewModel<string> | undefined)
    {
        this.SetField(NewTenantDialogViewModel.SelectedClientProperty, this.selectedClient, value, v => { this.selectedClient = v })
    }

    public get Id(): string
    {
        return this.id
    }

    public set Id(value: string)
    {
        const oldError = this.IdErrorText
        this.SetField(NewTenantDialogViewModel.IdProperty, this.id, value, v => { this.id = v })
        this.RaisePropertyChanged(NewTenantDialogViewModel.IdErrorTextProperty, oldError, this.IdErrorText)
    }

    // Why the typed tenant id is not accepted; '' while empty or valid.
    public get IdErrorText(): string
    {
        const id = this.id.trim()
        return id.length === 0 || NewTenantDialogViewModel.IdPattern.test(id) ? '' : NewTenantDialogViewModel.IdErrorMessage
    }

    public get DisplayName(): string
    {
        return this.displayName
    }

    public set DisplayName(value: string)
    {
        this.SetField(NewTenantDialogViewModel.DisplayNameProperty, this.displayName, value, v => { this.displayName = v })
    }

    public get OwnerEmail(): string
    {
        return this.ownerEmail
    }

    public set OwnerEmail(value: string)
    {
        this.SetField(NewTenantDialogViewModel.OwnerEmailProperty, this.ownerEmail, value, v => { this.ownerEmail = v })
    }

    protected override get CanConfirm(): boolean
    {
        return this.selectedClient !== undefined
            && NewTenantDialogViewModel.IdPattern.test(this.id.trim())
            && this.displayName.trim().length > 0
            && this.ownerEmail.trim().includes(NewTenantDialogViewModel.EmailMark)
    }

    protected override async SubmitCore(): Promise<CreatedTenantDto>
    {
        const clientId = this.selectedClient?.Value ?? ''
        return await this.Session.Client.CreateTenant(this.id.trim(), clientId, this.displayName.trim(), this.ownerEmail.trim())
    }
}
