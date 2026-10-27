import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button, ButtonVariant } from '@pragmatic-tech-ai/mural/framework'

export interface StepsInputs
{
    labels: string[]
    onChange?: (index: number) => void
}

// An ordered horizontal strip of step labels with one active step. It is a non-interactive
// indicator: the owner drives it via Select/Advance/Back; clicking a label does nothing. The active step wears
// the Primary button variant (a fill-and-weight difference, not hue alone); IsActiveStep
// is the test seam that reads it. No branching, validation, or animation.
export class Steps extends StackPanel
{
    private readonly inputs: StepsInputs
    private readonly buttons: Button[] = []
    private active = 0

    public constructor(inputs: StepsInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Horizontal
        this.Build()
    }

    // Test seam: index of the active step.
    public get ActiveIndex(): number
    {
        return this.active
    }

    // Test seam: whether the step at index is rendered as the active one.
    public IsActiveStep(index: number): boolean
    {
        return this.buttons[index].Variant === ButtonVariant.Primary
    }

    public Select(index: number): void
    {
        if (index === this.active || index < 0 || index >= this.inputs.labels.length)
        {
            return
        }
        this.active = index
        this.Refresh()
        this.inputs.onChange?.(index)
    }

    public Advance(): void
    {
        this.Select(this.active + 1)
    }

    public Back(): void
    {
        this.Select(this.active - 1)
    }

    private Build(): void
    {
        this.inputs.labels.forEach(label =>
        {
            const button = new Button()
            const text = new TextBlock()
            text.Text = label
            button.Content = text
            this.buttons.push(button)
            this.AddChild(button)
        })
        this.Refresh()
    }

    private Refresh(): void
    {
        this.buttons.forEach((button, i) =>
        {
            button.Variant = i === this.active ? ButtonVariant.Primary : ButtonVariant.Secondary
        })
    }
}
