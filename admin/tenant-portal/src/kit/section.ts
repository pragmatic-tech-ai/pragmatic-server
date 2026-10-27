import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'

export interface SectionInputs
{
    title: string
    sub?: string
    actions?: Visual
    body: Visual
}

// A titled block: header row (title, optional sub, optional actions) above the body.
export class Section extends StackPanel
{
    private readonly inputs: SectionInputs

    public constructor(inputs: SectionInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Vertical
        this.Build()
    }

    private Build(): void
    {
        const header = new StackPanel()
        header.Orientation = Orientation.Horizontal
        const title = new TextBlock()
        title.Text = this.inputs.title
        header.AddChild(title)
        if (this.inputs.sub !== undefined)
        {
            const sub = new TextBlock()
            sub.Text = this.inputs.sub
            header.AddChild(sub)
        }
        if (this.inputs.actions !== undefined)
        {
            header.AddChild(this.inputs.actions)
        }
        this.AddChild(header)
        this.AddChild(this.inputs.body)
    }
}
