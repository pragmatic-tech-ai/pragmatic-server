import { Icon, Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { IconCatalog, KitGlyph } from './icon-catalog.js'
import { PillTone, Tones } from './tones.js'

export enum BannerTone
{
    Info,
    Warning,
    Danger,
}

export interface BannerInputs
{
    tone: BannerTone
    text: string
    action?: Visual
}

interface BannerStyle
{
    glyph: KitGlyph
    label: string
    tone: PillTone
}

// Inline status banner: tone glyph + tone label + text, and an optional action visual.
export class Banner extends StackPanel
{
    private static readonly Styles: Readonly<Record<BannerTone, BannerStyle>> = {
        [BannerTone.Info]: { glyph: KitGlyph.CircleAlert, label: 'Info: ', tone: PillTone.Info },
        [BannerTone.Warning]: { glyph: KitGlyph.TriangleAlert, label: 'Warning: ', tone: PillTone.Warning },
        [BannerTone.Danger]: { glyph: KitGlyph.CircleX, label: 'Error: ', tone: PillTone.Danger },
    }

    private readonly inputs: BannerInputs

    public constructor(inputs: BannerInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Horizontal
        this.Build()
    }

    public get Tone(): BannerTone
    {
        return this.inputs.tone
    }

    public get Text(): string
    {
        return this.inputs.text
    }

    private Build(): void
    {
        const style = Banner.Styles[this.inputs.tone]
        const icon = new Icon()
        icon.Source = IconCatalog.Definition(style.glyph)
        icon.Foreground = Tones.Brush(style.tone)
        icon.Recolor = true
        const label = new TextBlock()
        label.Text = style.label
        const text = new TextBlock()
        text.Text = this.inputs.text
        this.AddChild(icon)
        this.AddChild(label)
        this.AddChild(text)
        if (this.inputs.action !== undefined)
        {
            this.AddChild(this.inputs.action)
        }
    }
}
