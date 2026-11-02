import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { ConsequenceList } from './consequence-list.js'
import type { INameConfirmRequest } from './tenant-page-view-model.js'
import { TenantDialogViewModel } from './tenant-dialog-view-model.js'
import type { TenantSessionService } from './tenant-session-service.js'

// Confirms an irreversible action by having the operator type the target's
// name. Confirm stays disabled until Typed matches Expected exactly; it then
// runs the action inside the dialog (a refusal shows in ErrorText) and closes
// with Confirmed. ConfirmLabel names the action on the confirm button (Delete
// by default). The consequences list what the action does.
export class NameConfirmDialogViewModel extends TenantDialogViewModel<boolean>
{
    public static readonly Confirmed = true

    private static readonly TypedProperty = 'Typed'
    private static readonly IsMatchProperty = 'IsMatch'
    private static readonly PromptTemplate = 'Type {name} to confirm.'
    private static readonly NameToken = '{name}'
    private static readonly DeleteLabel = 'Delete'

    private typed = ''

    public constructor(session: TenantSessionService, dialogs: DialogService, private readonly request: INameConfirmRequest)
    {
        super(session, dialogs, request.Capability)
    }

    public get Expected(): string
    {
        return this.request.Expected
    }

    public get Message(): string
    {
        return this.request.Message
    }

    public get ConfirmLabel(): string
    {
        return this.request.ConfirmLabel ?? NameConfirmDialogViewModel.DeleteLabel
    }

    // The consequences as one bulleted block; '' when there are none.
    public get ConsequencesText(): string
    {
        return ConsequenceList.Text(this.request.Consequences)
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
        return this.typed === this.request.Expected
    }

    public get PromptText(): string
    {
        return NameConfirmDialogViewModel.PromptTemplate.replace(NameConfirmDialogViewModel.NameToken, this.request.Expected)
    }

    protected override get CanConfirm(): boolean
    {
        return this.IsMatch
    }

    protected override async SubmitCore(): Promise<boolean>
    {
        await this.request.Action()
        return NameConfirmDialogViewModel.Confirmed
    }
}
