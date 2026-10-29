import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { KeyActivatedButton } from './key-activated-button.js'

export interface OnceSecretInputs
{
    label: string
    value: string
    confirmLabel: string
    onConfirm: () => void
}

// One-time reveal of a secret. The value lives only in the display Visual below; this class never
// persists it. The operator must activate the confirm control; onConfirm fires exactly once.
export class OnceSecret extends StackPanel
{
    private static readonly CopyLabel = 'Copy'

    private readonly inputs: OnceSecretInputs
    private readonly display: TextBlock
    private readonly confirmButton: KeyActivatedButton
    private confirmed = false

    public constructor(inputs: OnceSecretInputs)
    {
        super()
        this.inputs = inputs
        this.display = new TextBlock()
        this.confirmButton = new KeyActivatedButton(() => this.Confirm())
        this.Orientation = Orientation.Vertical
        this.Build()
    }

    // Test seam: whether the operator has confirmed the secret was saved.
    public get Confirmed(): boolean
    {
        return this.confirmed
    }

    // Test seam: the confirm control; Press() runs the same path as a click or Enter.
    public get ConfirmButton(): KeyActivatedButton
    {
        return this.confirmButton
    }

    // Test seam: the value as displayed in the Visual.
    public get Value(): string
    {
        return this.display.Text
    }

    private Build(): void
    {
        const label = new TextBlock()
        label.Text = this.inputs.label
        this.AddChild(label)

        this.display.Text = this.inputs.value
        this.AddChild(this.display)

        const copy = new KeyActivatedButton(() => this.Copy())
        const copyText = new TextBlock()
        copyText.Text = OnceSecret.CopyLabel
        copy.Content = copyText
        this.AddChild(copy)

        const confirmText = new TextBlock()
        confirmText.Text = this.inputs.confirmLabel
        this.confirmButton.Content = confirmText
        this.AddChild(this.confirmButton)
    }

    // Best-effort clipboard copy; a no-op where the Clipboard API is unavailable (e.g. under test).
    private Copy(): void
    {
        if (typeof navigator !== 'undefined' && navigator.clipboard)
        {
            void navigator.clipboard.writeText(this.inputs.value)
        }
    }

    private Confirm(): void
    {
        if (this.confirmed)
        {
            return
        }
        this.confirmed = true
        this.inputs.onConfirm()
    }
}
