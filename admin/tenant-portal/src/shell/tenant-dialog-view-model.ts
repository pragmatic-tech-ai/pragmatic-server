import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { ShellDialogViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import type { AdminCapability } from './admin-capability.js'
import type { TenantSessionService } from './tenant-session-service.js'

// Base for the console's dialogs: the shell's dialog (Confirm runs the submit inside the dialog, a 401 expires the
// session, a dismissal mid-submit still delivers its result) with the console's permission rule.
export abstract class TenantDialogViewModel<TResult> extends ShellDialogViewModel<TResult>
{
    protected declare readonly Session: TenantSessionService

    // `capability` is the permission the dialog's action needs: Confirm is disabled without it (the server refuses
    // it anyway). Undefined: the dialog needs no permission.
    protected constructor(session: TenantSessionService, dialogs: DialogService, private readonly capability: AdminCapability | undefined)
    {
        super(session, dialogs)
    }

    protected override get IsPermitted(): boolean
    {
        return this.capability === undefined || this.Session.Can(this.capability)
    }
}
