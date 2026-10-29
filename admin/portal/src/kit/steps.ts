import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { FontWeight } from '@pragmatic-tech-ai/mural/visual-engine'

export interface StepsInputs
{
    steps: readonly string[]
    current: number
    content: Visual
}

// A linear step indicator: a horizontal row of step labels (the one at `current` emphasised) above the content.
// Display only; advancing is driven by the owner rebuilding with a new `current`.
export class Steps extends StackPanel
{
    private static readonly ActiveWeight = FontWeight.Bold
    private static readonly InactiveWeight = FontWeight.Normal

    private readonly inputs: StepsInputs

    public constructor(inputs: StepsInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Vertical
        this.Build()
    }

    public get ActiveIndex(): number
    {
        return this.inputs.current
    }

    private Build(): void
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        this.inputs.steps.forEach((label, index) =>
        {
            const step = new TextBlock()
            step.Text = label
            step.FontWeight = index === this.inputs.current ? Steps.ActiveWeight : Steps.InactiveWeight
            row.AddChild(step)
        })
        this.AddChild(row)
        this.AddChild(this.inputs.content)
    }
}
