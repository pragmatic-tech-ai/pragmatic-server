import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import type { ClientDto } from '../../portal-types.js'
import { PortalDialogViewModel } from '../../shell/portal-dialog-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'

// Create client: an id, a display name and an optional subscription reference.
export class NewClientDialogViewModel extends PortalDialogViewModel<ClientDto>
{
    private static readonly IdProperty = 'Id'
    private static readonly DisplayNameProperty = 'DisplayName'
    private static readonly SubscriptionRefProperty = 'SubscriptionRef'

    private id = ''
    private displayName = ''
    private subscriptionRef = ''

    public constructor(session: PortalSessionService, dialogs: DialogService)
    {
        super(session, dialogs)
    }

    public get Id(): string
    {
        return this.id
    }

    public set Id(value: string)
    {
        this.SetField(NewClientDialogViewModel.IdProperty, this.id, value, v => { this.id = v })
    }

    public get DisplayName(): string
    {
        return this.displayName
    }

    public set DisplayName(value: string)
    {
        this.SetField(NewClientDialogViewModel.DisplayNameProperty, this.displayName, value, v => { this.displayName = v })
    }

    public get SubscriptionRef(): string
    {
        return this.subscriptionRef
    }

    public set SubscriptionRef(value: string)
    {
        this.SetField(NewClientDialogViewModel.SubscriptionRefProperty, this.subscriptionRef, value, v => { this.subscriptionRef = v })
    }

    protected override get CanConfirm(): boolean
    {
        return this.id.trim().length > 0 && this.displayName.trim().length > 0
    }

    protected override async SubmitCore(): Promise<ClientDto>
    {
        const subscription = this.subscriptionRef.trim()
        return await this.Session.Client.CreateClient(this.id.trim(), this.displayName.trim(), subscription.length > 0 ? subscription : undefined)
    }
}
