import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'

// Small bordered badge marking internal-only surfaces. Conveyed by text, not colour alone.
export class InternalTag extends StackPanel
{
    public static readonly LabelText = 'Internal'

    public constructor()
    {
        super()
        this.Orientation = Orientation.Horizontal
        const text = new TextBlock()
        text.Text = InternalTag.LabelText
        this.AddChild(text)
    }

    // Test seam: the badge text.
    public get Label(): string
    {
        return InternalTag.LabelText
    }
}
