import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { PortalDialogViewModel } from './portal-dialog-view-model.js'
import type { PortalSessionService } from './portal-session-service.js'

// Confirms an irreversible action by having the operator type the target's
// name. Confirm stays disabled until Typed matches Expected exactly; it then
// runs the action inside the dialog (a refusal such as "client has tenants"
// shows in ErrorText) and closes with Confirmed. ConfirmLabel names the
// action on the confirm button (Delete by default; Withdraw, Revoke...).
// With a ReasonLabel the dialog also asks why (a withdrawal records it):
// Confirm then needs a non-blank Reason, which the action receives trimmed.
export class NameConfirmDialogViewModel extends PortalDialogViewModel<boolean>
{
    public static readonly Confirmed = true

    private static readonly TypedProperty = 'Typed'
    private static readonly IsMatchProperty = 'IsMatch'
    private static readonly ReasonProperty = 'Reason'
    private static readonly PromptTemplate = 'Type {name} to confirm.'
    private static readonly NameToken = '{name}'
    private static readonly DeleteLabel = 'Delete'
    private static readonly NoReasonLabel = ''

    private typed = ''
    private reason = ''

    public constructor(
        session: PortalSessionService,
        dialogs: DialogService,
        public readonly Expected: string,
        public readonly Message: string,
        private readonly action: (reason: string) => Promise<void>,
        public readonly ConfirmLabel: string = NameConfirmDialogViewModel.DeleteLabel,
        public readonly ReasonLabel: string = NameConfirmDialogViewModel.NoReasonLabel,
    )
    {
        super(session, dialogs)
    }

    public get Typed(): string
    {
        return this.typed
    }

    public set Typed(value: string)
    {
        const wasMatch = this.IsMatch
        this.SetField(NameConfirmDialogViewModel.TypedProperty, this.typed, value, v => { this.typed = v })
        this.RaisePropertyChanged(NameConfirmDialogViewModel.IsMatchProperty, wasMatch, this.IsMatch)
    }

    public get IsMatch(): boolean
    {
        return this.typed === this.Expected
    }

    public get PromptText(): string
    {
        return NameConfirmDialogViewModel.PromptTemplate.replace(NameConfirmDialogViewModel.NameToken, this.Expected)
    }

    // Whether the dialog asks for a reason (its template shows the field).
    public get RequiresReason(): boolean
    {
        return this.ReasonLabel.length > 0
    }

    public get Reason(): string
    {
        return this.reason
    }

    public set Reason(value: string)
    {
        this.SetField(NameConfirmDialogViewModel.ReasonProperty, this.reason, value, v => { this.reason = v })
    }

    protected override get CanConfirm(): boolean
    {
        return this.IsMatch && (!this.RequiresReason || this.reason.trim().length > 0)
    }

    protected override async SubmitCore(): Promise<boolean>
    {
        await this.action(this.reason.trim())
        return NameConfirmDialogViewModel.Confirmed
    }
}
