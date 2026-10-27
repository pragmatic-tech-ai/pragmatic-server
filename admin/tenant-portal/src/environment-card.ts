import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { EnvironmentRow } from './environment-row.js'
import { StatusPill } from './kit/index.js'

export interface EnvironmentCardInputs
{
    row: EnvironmentRow
    onOpen: () => void
}

// One environment summarised as a card: name (opens it), status + health pills, app/version, live URL.
export class EnvironmentCard extends StackPanel
{
    private static readonly NotServingLabel = 'Not serving'
    private static readonly VersionPrefix = ' v'

    private readonly inputs: EnvironmentCardInputs

    public constructor(inputs: EnvironmentCardInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Vertical
        this.Build()
    }

    private Build(): void
    {
        const row = this.inputs.row
        const open = new Button()
        open.Content = this.Text(row.Name)
        open.AddClickHandler(() => this.inputs.onOpen())
        this.AddChild(open)

        const pills = new StackPanel()
        pills.Orientation = Orientation.Horizontal
        pills.AddChild(new StatusPill(row.StatusPill))
        pills.AddChild(new StatusPill(row.HealthPill))
        this.AddChild(pills)

        this.AddChild(this.Text(row.Template + EnvironmentCard.VersionPrefix + row.Version))
        this.AddChild(this.Text(row.Url ?? EnvironmentCard.NotServingLabel))
    }

    private Text(value: string): TextBlock
    {
        const t = new TextBlock()
        t.Text = value
        return t
    }
}
