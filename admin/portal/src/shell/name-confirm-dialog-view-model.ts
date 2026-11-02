import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { PortalDialogViewModel } from './portal-dialog-view-model.js'
import type { PortalSessionService } from './portal-session-service.js'

// Confirms an irreversible action by having the operator type the target's
// name. Confirm stays disabled until Typed matches Expected exactly; it then
// runs the action inside the dialog (a refusal such as "client has tenants"
// shows in ErrorText) and closes with Confirmed. ConfirmLabel names the
// action on the confirm button (Delete by default; Withdraw, Revoke...).
export class NameConfirmDialogViewModel extends PortalDialogViewModel<boolean>
{
    public static readonly Confirmed = true

    private static readonly TypedProperty = 'Typed'
    private static readonly IsMatchProperty = 'IsMatch'
    private static readonly PromptTemplate = 'Type {name} to confirm.'
    private static readonly NameToken = '{name}'
    private static readonly DeleteLabel = 'Delete'

    private typed = ''

    public constructor(
        session: PortalSessionService,
        dialogs: DialogService,
        public readonly Expected: string,
        public readonly Message: string,
        private readonly action: () => Promise<void>,
        public readonly ConfirmLabel: string = NameConfirmDialogViewModel.DeleteLabel,
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

    protected override get CanConfirm(): boolean
    {
        return this.IsMatch
    }

    protected override async SubmitCore(): Promise<boolean>
    {
        await this.action()
        return NameConfirmDialogViewModel.Confirmed
    }
}
