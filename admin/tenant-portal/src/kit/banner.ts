import { Icon, Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button, ButtonVariant } from '@pragmatic-tech-ai/mural/framework'
import { IconCatalog, KitGlyph } from './icon-catalog.js'
import { PillTone, Tones } from './tones.js'

export enum BannerTone
{
    Info = 'info',
    Warning = 'warning',
    Danger = 'danger',
}

export interface BannerInputs
{
    tone: BannerTone
    text: string
    actionLabel?: string
    onAction?: () => void
}

interface BannerStyle
{
    glyph: KitGlyph
    label: string
    tone: PillTone
}

// Inline status banner: tone glyph + tone label + text, and an optional action button.
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
        if (this.inputs.actionLabel !== undefined)
        {
            const button = new Button()
            const caption = new TextBlock()
            caption.Text = this.inputs.actionLabel
            button.Content = caption
            button.Variant = ButtonVariant.Secondary
            button.AddClickHandler(() => this.inputs.onAction?.())
            this.AddChild(button)
        }
    }
}
