import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import type { AdminCapability } from './admin-capability.js'
import { TenantDialogViewModel } from './tenant-dialog-view-model.js'
import type { TenantSessionService } from './tenant-session-service.js'

// A reversible-but-disruptive action asked as a plain yes / no.
export interface IConfirmRequest
{
    readonly Capability: AdminCapability
    readonly Title: string
    readonly Message: string
    // What happens, listed under the message.
    readonly Consequences?: readonly string[]
    // A warning shown above the buttons (e.g. "this is your own account").
    readonly Warning?: string
    // The confirm button's label.
    readonly ConfirmLabel: string
    // Whether the confirm button is styled as dangerous; true when omitted.
    readonly IsDanger?: boolean
    // Runs inside the dialog; a refusal shows there.
    readonly Action: () => Promise<void>
    // Runs after the dialog closes confirmed.
    readonly OnConfirmed: () => Promise<void>
}

// Asks before a disruptive action (stop an environment, disable an account,
// revoke a token, revoke your own grant). Confirm runs the action inside the
// dialog; a refusal stays open with ErrorText.
export class ConfirmDialogViewModel extends TenantDialogViewModel<boolean>
{
    public static readonly Confirmed = true

    private static readonly ConsequencePrefix = '- '
    private static readonly LineBreak = '\n'

    public constructor(session: TenantSessionService, dialogs: DialogService, private readonly request: IConfirmRequest)
    {
        super(session, dialogs, request.Capability)
    }

    public get Message(): string
    {
        return this.request.Message
    }

    public get ConsequencesText(): string
    {
        const lines = this.request.Consequences ?? []
        return lines.map(l => ConfirmDialogViewModel.ConsequencePrefix + l).join(ConfirmDialogViewModel.LineBreak)
    }

    public get Warning(): string
    {
        return this.request.Warning ?? ''
    }

    public get ConfirmLabel(): string
    {
        return this.request.ConfirmLabel
    }

    public get IsDanger(): boolean
    {
        return this.request.IsDanger ?? true
    }

    public get IsNotDanger(): boolean
    {
        return !this.IsDanger
    }

    protected override get CanConfirm(): boolean
    {
        return true
    }

    protected override async SubmitCore(): Promise<boolean>
    {
        await this.request.Action()
        return ConfirmDialogViewModel.Confirmed
    }
}
