import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../api-client.js'
import type { PortalSessionService } from './portal-session-service.js'

// Base for a dialog's view-model, shown through the shell's DialogService and
// rendered by its own implicit-by-type template. The template carries the
// Cancel / Confirm buttons (a DialogAction can't follow validation), bound to
// CancelCommand and ConfirmCommand. Confirm runs SubmitCore inside the dialog:
// success closes it with the result; a 401 expires the session; any other
// failure stays open with ErrorText. Cancel (and Escape / X) resolve
// undefined.
export abstract class PortalDialogViewModel<TResult> extends Observable
{
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly IsBusyProperty = 'IsBusy'
    private static readonly DialogWidth = 480

    protected readonly Session: PortalSessionService
    protected readonly Dialogs: DialogService
    private readonly confirmCommand: RelayCommand
    private readonly cancelCommand: RelayCommand
    private errorText = ''
    private busy = false

    protected constructor(session: PortalSessionService, dialogs: DialogService)
    {
        super()
        this.Session = session
        this.Dialogs = dialogs
        this.confirmCommand = new RelayCommand(() => { void this.Confirm() }, () => this.CanConfirmNow)
        this.cancelCommand = new RelayCommand(() => this.Cancel())
    }

    public get ConfirmCommand(): RelayCommand
    {
        return this.confirmCommand
    }

    public get CancelCommand(): RelayCommand
    {
        return this.cancelCommand
    }

    // Why the last confirm failed; '' when none.
    public get ErrorText(): string
    {
        return this.errorText
    }

    public get IsBusy(): boolean
    {
        return this.busy
    }

    // Opens this dialog; resolves with the submit result, or undefined when
    // cancelled.
    public Open(title: string): Promise<TResult | undefined>
    {
        return this.Dialogs.Show<TResult>({ Title: title, Content: this, Width: PortalDialogViewModel.DialogWidth })
    }

    public async Confirm(): Promise<void>
    {
        if (!this.CanConfirmNow)
        {
            return
        }
        this.SetErrorText('')
        this.SetBusy(true)
        try
        {
            const result = await this.SubmitCore()
            this.Dialogs.Close(result)
        }
        catch (e)
        {
            if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
            {
                this.Session.Expire()
                this.Dialogs.Close(undefined)
                return
            }
            this.SetErrorText(e instanceof Error ? e.message : String(e))
        }
        finally
        {
            this.SetBusy(false)
        }
    }

    public Cancel(): void
    {
        this.Dialogs.Close(undefined)
    }

    // Whether the fields are complete and valid enough to submit.
    protected abstract get CanConfirm(): boolean

    // Performs the dialog's action; its result closes the dialog.
    protected abstract SubmitCore(): Promise<TResult>

    // Subclasses call this when a field that CanConfirm reads changes.
    protected RaiseCanConfirmChanged(): void
    {
        this.confirmCommand.RaiseCanExecuteChanged()
    }

    // Sets a form field: assigns, raises its change and re-evaluates Confirm.
    protected SetField<T>(name: string, old: T, next: T, assign: (value: T) => void): void
    {
        if (old === next)
        {
            return
        }
        assign(next)
        this.RaisePropertyChanged(name, old, next)
        this.RaiseCanConfirmChanged()
    }

    private get CanConfirmNow(): boolean
    {
        return !this.busy && this.Session.CanMutate && this.CanConfirm
    }

    private SetErrorText(next: string): void
    {
        const old = this.errorText
        if (old === next)
        {
            return
        }
        this.errorText = next
        this.RaisePropertyChanged(PortalDialogViewModel.ErrorTextProperty, old, next)
    }

    private SetBusy(next: boolean): void
    {
        const old = this.busy
        if (old === next)
        {
            return
        }
        this.busy = next
        this.RaisePropertyChanged(PortalDialogViewModel.IsBusyProperty, old, next)
        this.confirmCommand.RaiseCanExecuteChanged()
    }
}
