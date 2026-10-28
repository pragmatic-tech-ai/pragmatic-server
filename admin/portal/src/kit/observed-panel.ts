import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { PillKind } from './pill-kinds.js'
import { StatusPill } from './status-pill.js'

export interface ObservedPanelInputs
{
    title: string
    note?: string
    body: Visual
}

// A read-only panel of data observed from a hive's last check-in. Trust boundary:
// observe, never command - this primitive adds NO interactive control of its own.
//
// Deliberate deferrals (not dead code): this kit primitive is a mandated PA-4 Goal built ahead of its
// first production consumer - the Fleet home is an aggregate (counts + table), so the first per-hive
// observed-inventory rendering lands with Hive/Tenant detail (PA-7/PA-6). The dashed/outlined container
// the design describes is also deferred: Mural exposes no border theme token and inventing a hex border
// would break theme-token discipline, so the "observed" semantics are carried by the pill + note +
// no-actions contract; the dashed visual is PA-15 polish.
export class ObservedPanel extends StackPanel
{
    private static readonly DefaultNote = "Read from the hive's last check-in. No break-glass."

    private readonly inputs: ObservedPanelInputs

    public constructor(inputs: ObservedPanelInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Vertical
        this.Build()
    }

    public get Title(): string
    {
        return this.inputs.title
    }

    public get NoteText(): string
    {
        return this.inputs.note ?? ObservedPanel.DefaultNote
    }

    private Build(): void
    {
        const header = new StackPanel()
        header.Orientation = Orientation.Horizontal
        const title = new TextBlock()
        title.Text = this.Title
        header.AddChild(title)
        header.AddChild(new StatusPill(PillKind.Observed))
        this.AddChild(header)
        const note = new TextBlock()
        note.Text = this.NoteText
        this.AddChild(note)
        this.AddChild(this.inputs.body)
    }
}
