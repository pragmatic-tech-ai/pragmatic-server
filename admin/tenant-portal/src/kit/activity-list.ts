import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { PillKind } from './pill-kinds.js'
import { StatusPill } from './status-pill.js'

// Minimal render contract so the kit stays data-agnostic.
export interface ActivityListItem
{
    readonly Summary: string
    readonly Pill: PillKind
    RelativeTime(now?: () => number): string
}

export interface ActivityListInputs
{
    entries: readonly ActivityListItem[]
    max?: number
    emptyText: string
}

// Compact list of activity rows (pill + summary + relative time), or an empty-state line.
export class ActivityList extends StackPanel
{
    private rows: StackPanel[] = []
    private empty = true

    public constructor(inputs: ActivityListInputs)
    {
        super()
        this.Orientation = Orientation.Vertical
        this.Update(inputs)
    }

    public get Rows(): readonly StackPanel[]
    {
        return this.rows
    }

    public get IsEmpty(): boolean
    {
        return this.empty
    }

    public Update(inputs: ActivityListInputs): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
        this.rows = []
        const shown = inputs.max === undefined ? inputs.entries : inputs.entries.slice(0, inputs.max)
        this.empty = shown.length === 0
        if (this.empty)
        {
            const text = new TextBlock()
            text.Text = inputs.emptyText
            this.AddChild(text)
            return
        }
        for (const item of shown)
        {
            const row = new StackPanel()
            row.Orientation = Orientation.Horizontal
            row.AddChild(new StatusPill(item.Pill))
            const summary = new TextBlock()
            summary.Text = item.Summary
            row.AddChild(summary)
            const when = new TextBlock()
            when.Text = item.RelativeTime()
            row.AddChild(when)
            this.AddChild(row)
            this.rows.push(row)
        }
    }
}
