import { Icon, Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { IconCatalog } from './icon-catalog.js'
import { PillKind, PillKinds } from './pill-kinds.js'
import { Tones } from './tones.js'

// Icon + text status pill (never colour alone). Reusable inline or in a table cell.
export class StatusPill extends StackPanel
{
    private kind: PillKind
    private labelOverride: string | undefined

    public constructor(kind: PillKind = PillKind.Unknown)
    {
        super()
        this.kind = kind
        this.Orientation = Orientation.Horizontal
        this.Build()
    }

    public get Kind(): PillKind
    {
        return this.kind
    }

    public set Kind(value: PillKind)
    {
        this.kind = value
        this.Build()
    }

    public get LabelOverride(): string | undefined
    {
        return this.labelOverride
    }

    public set LabelOverride(value: string | undefined)
    {
        this.labelOverride = value
        this.Build()
    }

    private Build(): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
        const entry = PillKinds.Entry(this.kind)
        const icon = new Icon()
        icon.Source = IconCatalog.Definition(entry.glyph)
        icon.Foreground = Tones.Brush(entry.tone)
        icon.Recolor = true
        const text = new TextBlock()
        text.Text = this.labelOverride ?? entry.label
        this.AddChild(icon)
        this.AddChild(text)
    }
}
