import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { NameConfirmDialogViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { ConsequenceList } from './consequence-list.js'
import type { INameConfirmRequest } from './tenant-page-view-model.js'
import type { TenantSessionService } from './tenant-session-service.js'

// The shell's name-to-confirm dialog with the console's permission rule (Confirm needs the request's capability, as
// every console dialog: TenantDialogViewModel) and the consequences the action has, listed under the message.
export class TenantNameConfirmDialogViewModel extends NameConfirmDialogViewModel
{
    protected declare readonly Session: TenantSessionService

    public constructor(session: TenantSessionService, dialogs: DialogService, private readonly tenantRequest: INameConfirmRequest)
    {
        super(session, dialogs, tenantRequest)
    }

    // The consequences as one bulleted block; '' when there are none.
    public get ConsequencesText(): string
    {
        return ConsequenceList.Text(this.tenantRequest.Consequences)
    }

    protected override get IsPermitted(): boolean
    {
        return this.Session.Can(this.tenantRequest.Capability)
    }
}
