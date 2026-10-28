import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Act, ActVariant } from './act.js'
import { PillKind } from './pill-kinds.js'
import { StatusPill } from './status-pill.js'

export interface SecretRow
{
    reference: string
    note?: string
    status: PillKind
    revoked: boolean
}

export interface SecretTableInputs
{
    rows: readonly SecretRow[]
    canRevoke: boolean
    need?: string
    onRevoke: (reference: string) => void
}

// By-reference list of issued secrets. Shows the reference, an optional note, a status pill and
// a gated Revoke action per row. It never receives or renders a secret value.
export class SecretTable extends StackPanel
{
    private static readonly RevokeLabel = 'Revoke'

    private readonly inputs: SecretTableInputs
    private readonly acts: Act[] = []

    public constructor(inputs: SecretTableInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Vertical
        this.Build()
    }

    // Test seam: number of secret rows.
    public get RowCount(): number
    {
        return this.inputs.rows.length
    }

    // Test seam: the reference shown on a row.
    public ReferenceAt(index: number): string
    {
        return this.inputs.rows[index].reference
    }

    // Test seam: the Revoke action of a row.
    public RevokeAct(index: number): Act
    {
        return this.acts[index]
    }

    private Build(): void
    {
        for (const row of this.inputs.rows)
        {
            this.AddChild(this.BuildRow(row))
        }
    }

    private BuildRow(row: SecretRow): StackPanel
    {
        const panel = new StackPanel()
        panel.Orientation = Orientation.Horizontal
        const reference = new TextBlock()
        reference.Text = row.reference
        panel.AddChild(reference)
        if (row.note !== undefined)
        {
            const note = new TextBlock()
            note.Text = row.note
            panel.AddChild(note)
        }
        panel.AddChild(new StatusPill(row.status))
        const act = new Act({
            can: this.inputs.canRevoke && !row.revoked,
            need: this.inputs.need,
            variant: ActVariant.Danger,
            label: SecretTable.RevokeLabel,
            onClick: () => this.inputs.onRevoke(row.reference),
        })
        this.acts.push(act)
        panel.AddChild(act)
        return panel
    }
}
