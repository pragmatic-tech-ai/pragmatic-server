import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'

export interface KeyValueItem
{
    key: string
    value: string | Visual
}

export interface KeyValueGridInputs
{
    items: KeyValueItem[]
    cols?: number
}

// Key/value pairs laid out in `cols` columns: vertical stack of horizontal rows of cells.
export class KeyValueGrid extends StackPanel
{
    private static readonly DefaultCols = 2

    private readonly inputs: KeyValueGridInputs

    public constructor(inputs: KeyValueGridInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Vertical
        this.Build()
    }

    public get Cols(): number
    {
        const requested = this.inputs.cols
        if (requested === undefined || !Number.isFinite(requested))
        {
            return KeyValueGrid.DefaultCols
        }
        return Math.max(1, Math.floor(requested))
    }

    private Build(): void
    {
        const cols = this.Cols
        const items = this.inputs.items
        for (let start = 0; start < items.length; start += cols)
        {
            const row = new StackPanel()
            row.Orientation = Orientation.Horizontal
            for (const item of items.slice(start, start + cols))
            {
                row.AddChild(this.Cell(item))
            }
            this.AddChild(row)
        }
    }

    private Cell(item: KeyValueItem): StackPanel
    {
        const cell = new StackPanel()
        cell.Orientation = Orientation.Vertical
        const key = new TextBlock()
        key.Text = item.key
        cell.AddChild(key)
        if (typeof item.value === 'string')
        {
            const value = new TextBlock()
            value.Text = item.value
            cell.AddChild(value)
        }
        else
        {
            cell.AddChild(item.value)
        }
        return cell
    }
}
