import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { NameConfirmDialogViewModel, type NameConfirmRequest } from '@pragmatic-tech-ai/pragmatic-app-shell'
import type { PortalSessionService } from './portal-session-service.js'

// The shell's name-to-confirm dialog with the console's permission rule: Confirm needs the Operator (mutating) role,
// as every console dialog (PortalDialogViewModel).
export class PortalNameConfirmDialogViewModel extends NameConfirmDialogViewModel
{
    protected declare readonly Session: PortalSessionService

    public constructor(session: PortalSessionService, dialogs: DialogService, request: NameConfirmRequest)
    {
        super(session, dialogs, request)
    }

    protected override get IsPermitted(): boolean
    {
        return this.Session.CanMutate
    }
}
