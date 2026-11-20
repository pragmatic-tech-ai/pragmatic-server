import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { ShellDialogViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import type { PortalSessionService } from './portal-session-service.js'

// Base for the console's dialogs: the shell's dialog (Confirm runs the submit inside the dialog, a 401 expires the
// session, a dismissal mid-submit still delivers its result) with the console's permission rule: Confirm needs the
// Operator role unless the dialog says otherwise.
export abstract class PortalDialogViewModel<TResult> extends ShellDialogViewModel<TResult>
{
    protected declare readonly Session: PortalSessionService

    protected constructor(session: PortalSessionService, dialogs: DialogService)
    {
        super(session, dialogs)
    }

    // Whether Confirm needs the mutating (Operator) role.
    protected get RequiresMutate(): boolean
    {
        return true
    }

    protected override get IsPermitted(): boolean
    {
        return !this.RequiresMutate || this.Session.CanMutate
    }
}
