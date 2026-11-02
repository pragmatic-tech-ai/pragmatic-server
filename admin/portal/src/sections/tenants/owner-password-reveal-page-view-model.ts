import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { TenantsSectionService } from './tenants-section-service.js'

// The new tenant's Owner password, shown once. A page, not a dialog: a dialog
// closes on Escape, and this must stay until the operator confirms they saved
// it. Confirming clears the value and moves on to the tenant's detail; leaving
// through the rail first keeps this page as the section's current one. The
// value is never logged and lives nowhere else.
export class OwnerPasswordRevealPageViewModel extends Observable
{
    private static readonly ValueProperty = 'Value'
    private static readonly SavedProperty = 'Saved'
    private static readonly CopyStatusProperty = 'CopyStatus'
    private static readonly CopiedText = 'Copied.'
    private static readonly CopyFailedText = 'Could not copy. Select the password and copy it by hand.'

    private value: string
    private saved = false
    private copyStatus = ''
    private readonly confirmSavedCommand: RelayCommand
    private readonly copyCommand: RelayCommand

    public constructor(private readonly section: TenantsSectionService, public readonly TenantId: string, public readonly Email: string, value: string)
    {
        super()
        this.value = value
        this.confirmSavedCommand = new RelayCommand(() => this.ConfirmSaved(), () => this.saved && this.value.length > 0)
        this.copyCommand = new RelayCommand(() => { void this.Copy() }, () => this.value.length > 0)
    }

    // The one-time password; '' once the operator has confirmed saving it.
    public get Value(): string
    {
        return this.value
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
        this.RaisePropertyChanged(OwnerPasswordRevealPageViewModel.SavedProperty, old, next)
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

    private ConfirmSaved(): void
    {
        if (!this.confirmSavedCommand.CanExecute())
        {
            return
        }
        const old = this.value
        this.value = ''
        this.RaisePropertyChanged(OwnerPasswordRevealPageViewModel.ValueProperty, old, '')
        this.confirmSavedCommand.RaiseCanExecuteChanged()
        this.copyCommand.RaiseCanExecuteChanged()
        this.section.ShowTenantAfterReveal(this.TenantId)
    }

    private async Copy(): Promise<void>
    {
        const clipboard = this.section.Clipboard
        if (clipboard === undefined)
        {
            this.SetCopyStatus(OwnerPasswordRevealPageViewModel.CopyFailedText)
            return
        }
        try
        {
            await clipboard.WriteText(this.value)
            this.SetCopyStatus(OwnerPasswordRevealPageViewModel.CopiedText)
        }
        catch
        {
            this.SetCopyStatus(OwnerPasswordRevealPageViewModel.CopyFailedText)
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
        this.RaisePropertyChanged(OwnerPasswordRevealPageViewModel.CopyStatusProperty, old, next)
    }
}
