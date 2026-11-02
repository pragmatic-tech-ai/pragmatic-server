import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import type { ClipboardService } from '@pragmatic-tech-ai/mural/framework/shell/services/clipboard-service.js'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { IHoldsPendingSecret } from './holds-pending-secret.js'

// Where a reveal page copies to: its section (the shell's clipboard seam).
export interface IClipboardSource
{
    readonly Clipboard: ClipboardService | undefined
}

// Base for a one-time secret shown once (an Owner password, a reset
// password). A page, not a dialog: a dialog closes on Escape, and this must
// stay until the operator confirms they saved it. Confirming clears the value
// and calls OnSaved (each page moves on to its destination); leaving through
// the rail first keeps the page as the section's current one, and no section
// navigation drops or covers it until then (IHoldsPendingSecret). The value is
// never logged and lives nowhere else.
export abstract class OneTimeSecretPageViewModel extends Observable implements IHoldsPendingSecret
{
    private static readonly ValueProperty = 'Value'
    private static readonly SavedProperty = 'Saved'
    private static readonly CopyStatusProperty = 'CopyStatus'
    private static readonly CopiedText = 'Copied.'
    private static readonly CopyFailedText = 'Could not copy. Select the password and copy it by hand.'
    private static readonly NoText = ''

    private value: string
    private saved = false
    private copyStatus = OneTimeSecretPageViewModel.NoText
    private readonly confirmSavedCommand: RelayCommand
    private readonly copyCommand: RelayCommand

    protected constructor(private readonly clipboardSource: IClipboardSource, value: string)
    {
        super()
        this.value = value
        this.confirmSavedCommand = new RelayCommand(() => this.ConfirmSaved(), () => this.saved && this.value.length > 0)
        this.copyCommand = new RelayCommand(() => { void this.Copy() }, () => this.value.length > 0)
    }

    // The one-time secret; '' once the operator has confirmed saving it.
    public get Value(): string
    {
        return this.value
    }

    // True until the operator confirms saving the value: the section keeps
    // this page current meanwhile.
    public get HasPendingSecret(): boolean
    {
        return this.value.length > 0
    }

    // The operator's "I've saved it" acknowledgement.
    public get Saved(): boolean
    {
        return this.saved
    }

    public set Saved(next: boolean)
    {
        const old = this.saved
        if (old === next)
        {
            return
        }
        this.saved = next
        this.RaisePropertyChanged(OneTimeSecretPageViewModel.SavedProperty, old, next)
        this.confirmSavedCommand.RaiseCanExecuteChanged()
    }

    public get CopyStatus(): string
    {
        return this.copyStatus
    }

    public get ConfirmSavedCommand(): RelayCommand
    {
        return this.confirmSavedCommand
    }

    public get CopyCommand(): RelayCommand
    {
        return this.copyCommand
    }

    // Runs once the value is cleared: move on to the destination page.
    protected abstract OnSaved(): void

    private ConfirmSaved(): void
    {
        if (!this.confirmSavedCommand.CanExecute())
        {
            return
        }
        const old = this.value
        this.value = OneTimeSecretPageViewModel.NoText
        this.RaisePropertyChanged(OneTimeSecretPageViewModel.ValueProperty, old, this.value)
        this.confirmSavedCommand.RaiseCanExecuteChanged()
        this.copyCommand.RaiseCanExecuteChanged()
        this.OnSaved()
    }

    private async Copy(): Promise<void>
    {
        const clipboard = this.clipboardSource.Clipboard
        if (clipboard === undefined)
        {
            this.SetCopyStatus(OneTimeSecretPageViewModel.CopyFailedText)
            return
        }
        try
        {
            await clipboard.WriteText(this.value)
            this.SetCopyStatus(OneTimeSecretPageViewModel.CopiedText)
        }
        catch
        {
            this.SetCopyStatus(OneTimeSecretPageViewModel.CopyFailedText)
        }
    }

    private SetCopyStatus(next: string): void
    {
        const old = this.copyStatus
        if (old === next)
        {
            return
        }
        this.copyStatus = next
        this.RaisePropertyChanged(OneTimeSecretPageViewModel.CopyStatusProperty, old, next)
    }
}
