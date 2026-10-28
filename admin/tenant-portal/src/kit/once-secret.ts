import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Button, ButtonVariant } from '@pragmatic-tech-ai/mural/framework'

export interface OnceSecretInputs
{
    title: string
    value: string
    hint?: string
    onDone: () => void
}

// Shown-once secret reveal: title, read-only value, optional hint and a single
// "I have stored it" gate. Once the gate is pressed the value is cleared and never retained.
export class OnceSecret extends StackPanel
{
    private static readonly StoreLabel = 'I have stored it'
    private static readonly Cleared = ''

    private readonly inputs: OnceSecretInputs
    private readonly valueBox = new TextBox()
    private stored = false

    public constructor(inputs: OnceSecretInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Vertical
        this.Build()
    }

    public get Value(): string
    {
        return this.valueBox.Text
    }

    public get Stored(): boolean
    {
        return this.stored
    }

    public PressStore(): void
    {
        if (this.stored)
        {
            return
        }
        this.stored = true
        this.valueBox.Text = OnceSecret.Cleared
        this.RemoveChild(this.valueBox)
        this.inputs.onDone()
    }

    private Build(): void
    {
        const title = new TextBlock()
        title.Text = this.inputs.title
        this.AddChild(title)
        this.valueBox.IsReadOnly = true
        this.valueBox.Text = this.inputs.value
        this.AddChild(this.valueBox)
        if (this.inputs.hint !== undefined)
        {
            const hint = new TextBlock()
            hint.Text = this.inputs.hint
            this.AddChild(hint)
        }
        const button = new Button()
        const caption = new TextBlock()
        caption.Text = OnceSecret.StoreLabel
        button.Content = caption
        button.Variant = ButtonVariant.Primary
        button.AddClickHandler(() => this.PressStore())
        this.AddChild(button)
    }
}
