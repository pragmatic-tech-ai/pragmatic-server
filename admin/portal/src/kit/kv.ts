import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'

export interface KeyValueItem
{
    key: string
    value: string
}

export interface KeyValueGridInputs
{
    items: KeyValueItem[]
}

// Key/value pairs: a vertical stack of cells, each a key above its value.
export class KeyValueGrid extends StackPanel
{
    private readonly inputs: KeyValueGridInputs

    public constructor(inputs: KeyValueGridInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Vertical
        this.Build()
    }

    private Build(): void
    {
        for (const item of this.inputs.items)
        {
            const cell = new StackPanel()
            cell.Orientation = Orientation.Vertical
            const key = new TextBlock()
            key.Text = item.key
            const value = new TextBlock()
            value.Text = item.value
            cell.AddChild(key)
            cell.AddChild(value)
            this.AddChild(cell)
        }
    }
}
