import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantApiError } from '../tenant-api-client.js'
import type { AdminCapability } from './admin-capability.js'
import type { TenantSessionService } from './tenant-session-service.js'

// Base for a dialog's view-model, shown through the shell's DialogService and
// rendered by its own implicit-by-type template. The template carries the
// Cancel / Confirm buttons (a DialogAction can't follow validation), bound to
// CancelCommand and ConfirmCommand. Confirm runs SubmitCore inside the dialog:
// success closes it with the result; a 401 expires the session; any other
// failure stays open with ErrorText. Cancel (and Escape / X) resolve
// undefined.
//
// A submit outlives its dialog: if the operator dismisses the dialog (Escape,
// X) while the request is in flight, Open still resolves with the submit's
// result once it lands, so a one-time secret in it is never dropped; a late
// failure rejects Open instead. Close is scoped: this dialog only ever closes
// itself, never a newer dialog that replaced it. The scrim does not dismiss.
export abstract class TenantDialogViewModel<TResult> extends Observable
{
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly IsBusyProperty = 'IsBusy'
    private static readonly NoErrorText = ''
    private static readonly DialogWidth = 480
    // The dialog each service was last asked to show, by identity: a newer
    // Open takes it over synchronously, before the older Show settles.
    private static readonly Current = new WeakMap<DialogService, object>()

    protected readonly Session: TenantSessionService
    protected readonly Dialogs: DialogService
    private readonly confirmCommand: RelayCommand
    private readonly cancelCommand: RelayCommand
    private errorText = ''
    private busy = false
    private isOpen = false
    private inflight: Promise<TResult | undefined> | undefined

    // `capability` is the permission the dialog's action needs: Confirm is
    // disabled without it (the server refuses it anyway).
    protected constructor(session: TenantSessionService, dialogs: DialogService, private readonly capability: AdminCapability)
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

    // Loads what the dialog offers (choices) before it opens; none by default.
    public async Load(): Promise<void>
    {
    }

    // Opens this dialog; resolves with the submit result, or undefined when
    // cancelled. A dismissal while a submit is in flight waits for that
    // submit, resolving with its result (or rejecting with its failure).
    public async Open(title: string): Promise<TResult | undefined>
    {
        this.isOpen = true
        TenantDialogViewModel.Current.set(this.Dialogs, this)
        let shown: TResult | undefined
        try
        {
            shown = await this.Dialogs.Show<TResult>({
                Title: title, Content: this, Width: TenantDialogViewModel.DialogWidth, DismissOnScrimClick: false,
            })
        }
        finally
        {
            this.isOpen = false
            if (TenantDialogViewModel.Current.get(this.Dialogs) === this)
            {
                TenantDialogViewModel.Current.delete(this.Dialogs)
            }
        }
        const pending = this.inflight
        this.inflight = undefined
        if (shown !== undefined || pending === undefined)
        {
            return shown
        }
        return await pending
    }

    public async Confirm(): Promise<void>
    {
        if (!this.CanConfirmNow)
        {
            return
        }
        const run = this.Submit()
        this.inflight = run
        try
        {
            await run
        }
        catch
        {
            // A failure after dismissal is reported through Open's rejection.
        }
    }

    public Cancel(): void
    {
        this.CloseIfOpen(undefined)
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

    private async Submit(): Promise<TResult | undefined>
    {
        this.SetErrorText(TenantDialogViewModel.NoErrorText)
        this.SetBusy(true)
        try
        {
            const result = await this.SubmitCore()
            this.CloseIfOpen(result)
            return result
        }
        catch (e)
        {
            if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
            {
                this.Session.Expire()
                this.CloseIfOpen(undefined)
                return undefined
            }
            if (!this.isOpen)
            {
                throw e
            }
            this.SetErrorText(e instanceof Error ? e.message : String(e))
            return undefined
        }
        finally
        {
            this.SetBusy(false)
        }
    }

    // Closes this dialog only while it is still the one the service shows:
    // after a dismissal (or a newer Open, even before this dialog's own Show
    // has settled) it must not close someone else's dialog.
    private CloseIfOpen(result: TResult | undefined): void
    {
        if (this.isOpen && TenantDialogViewModel.Current.get(this.Dialogs) === this)
        {
            this.Dialogs.Close(result)
        }
    }

    private get CanConfirmNow(): boolean
    {
        return !this.busy && this.Session.Can(this.capability) && this.CanConfirm
    }

    private SetErrorText(next: string): void
    {
        const old = this.errorText
        if (old === next)
        {
            return
        }
        this.errorText = next
        this.RaisePropertyChanged(TenantDialogViewModel.ErrorTextProperty, old, next)
    }

    private SetBusy(next: boolean): void
    {
        const old = this.busy
        if (old === next)
        {
            return
        }
        this.busy = next
        this.RaisePropertyChanged(TenantDialogViewModel.IsBusyProperty, old, next)
        this.confirmCommand.RaiseCanExecuteChanged()
    }
}
