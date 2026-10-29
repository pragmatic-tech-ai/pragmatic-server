import { Icon, Orientation, Rectangle, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Thickness } from '@pragmatic-tech-ai/mural/runtime'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { IconCatalog, KitGlyph } from './icon-catalog.js'
import { KeyActivatedButton } from './key-activated-button.js'
import { PillTone, Tones } from './tones.js'

export enum SkeletonKind
{
    Table,
    Detail,
    Cards,
    Form,
}

// Placeholder bars/cards shown while a screen loads. No real data; neutral themed surface.
export class SkeletonPanel extends StackPanel
{
    // Role marker: Mural has no ARIA bridge, so the busy state is exposed as a Tag.
    public static readonly BusyRole = 'busy'

    private static readonly BarHeight = 14
    private static readonly CardHeight = 72
    private static readonly CardWidth = 160
    private static readonly Gap = 8
    private static readonly TableRows = 6
    private static readonly DetailLines = 4
    private static readonly CardCount = 3
    private static readonly FormFields = 4

    private readonly kind: SkeletonKind

    public constructor(kind: SkeletonKind = SkeletonKind.Table)
    {
        super()
        this.kind = kind
        this.Orientation = Orientation.Vertical
        this.Tag = SkeletonPanel.BusyRole
        this.Build()
    }

    public get Role(): string
    {
        return SkeletonPanel.BusyRole
    }

    public get Kind(): SkeletonKind
    {
        return this.kind
    }

    private Build(): void
    {
        switch (this.kind)
        {
            case SkeletonKind.Table:
                this.AddBars(SkeletonPanel.TableRows)
                break
            case SkeletonKind.Detail:
                this.AddChild(this.Block(SkeletonPanel.CardHeight, SkeletonPanel.CardWidth))
                this.AddBars(SkeletonPanel.DetailLines)
                break
            case SkeletonKind.Cards:
                this.AddCards()
                break
            case SkeletonKind.Form:
                this.AddForm()
                break
        }
    }

    private AddBars(count: number): void
    {
        for (let i = 0; i < count; i++)
        {
            this.AddChild(this.Block(SkeletonPanel.BarHeight))
        }
    }

    private AddCards(): void
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        for (let i = 0; i < SkeletonPanel.CardCount; i++)
        {
            row.AddChild(this.Block(SkeletonPanel.CardHeight, SkeletonPanel.CardWidth))
        }
        this.AddChild(row)
    }

    private AddForm(): void
    {
        for (let i = 0; i < SkeletonPanel.FormFields; i++)
        {
            this.AddChild(this.Block(SkeletonPanel.BarHeight, SkeletonPanel.CardWidth))
            this.AddChild(this.Block(SkeletonPanel.CardHeight / 2))
        }
    }

    private Block(height: number, width?: number): Rectangle
    {
        const rect = new Rectangle()
        rect.Height = height
        if (width !== undefined)
        {
            rect.Width = width
        }
        rect.Margin = new Thickness(0, SkeletonPanel.Gap / 2)
        rect.Fill = Tones.SoftBrush(PillTone.Neutral)
        return rect
    }
}

export interface EmptyStateConfig
{
    glyph?: KitGlyph
    title: string
    action?: Visual
    secondaryAction?: Visual
}

export interface ErrorStateConfig
{
    title: string
    body?: string
    onRetry?: () => void
}

export interface DeniedStateConfig
{
    what: string
    need: string
    ask?: string
}

// Shared icon + heading + body layout for the state panels.
abstract class StatePanelBase extends StackPanel
{
    protected constructor()
    {
        super()
        this.Orientation = Orientation.Vertical
    }

    protected Glyph(glyph: KitGlyph, tone: PillTone): Icon
    {
        const icon = new Icon()
        icon.Source = IconCatalog.Definition(glyph)
        icon.Foreground = Tones.Brush(tone)
        icon.Recolor = true
        return icon
    }

    protected Text(text: string): TextBlock
    {
        const block = new TextBlock()
        block.Text = text
        return block
    }
}

export class EmptyStatePanel extends StatePanelBase
{
    public static readonly DefaultGlyph = KitGlyph.CircleDashed

    private readonly config: EmptyStateConfig

    public constructor(config: EmptyStateConfig)
    {
        super()
        this.config = config
        this.Build()
    }

    public get Config(): EmptyStateConfig
    {
        return this.config
    }

    private Build(): void
    {
        this.AddChild(this.Glyph(this.config.glyph ?? EmptyStatePanel.DefaultGlyph, PillTone.Neutral))
        this.AddChild(this.Text(this.config.title))
        if (this.config.action !== undefined)
        {
            this.AddChild(this.config.action)
        }
        if (this.config.secondaryAction !== undefined)
        {
            this.AddChild(this.config.secondaryAction)
        }
    }
}

export class ErrorStatePanel extends StatePanelBase
{
    public static readonly DefaultBody = 'The request did not complete. Your data is unchanged. Try again; if it keeps failing, check the service status.'
    public static readonly RetryLabel = 'Try again'
    // Role marker: Mural has no live-region/alert API, so the alert role is exposed as a Tag.
    public static readonly AlertRole = 'alert'

    private readonly retryButton: KeyActivatedButton
    private readonly config: ErrorStateConfig

    public constructor(config: ErrorStateConfig)
    {
        super()
        this.config = config
        this.Tag = ErrorStatePanel.AlertRole
        this.retryButton = new KeyActivatedButton(config.onRetry)
        this.retryButton.Content = this.Text(ErrorStatePanel.RetryLabel)
        this.Build()
    }

    public get Role(): string
    {
        return ErrorStatePanel.AlertRole
    }

    public get RetryButton(): KeyActivatedButton
    {
        return this.retryButton
    }

    private Build(): void
    {
        this.AddChild(this.Glyph(KitGlyph.CircleAlert, PillTone.Danger))
        this.AddChild(this.Text(this.config.title))
        this.AddChild(this.Text(this.config.body ?? ErrorStatePanel.DefaultBody))
        this.AddChild(this.retryButton)
    }
}

export class DeniedStatePanel extends StatePanelBase
{
    public static readonly DefaultAsk = 'an administrator'

    private static readonly HeadingPrefix = 'You do not have access to '
    private static readonly BodyPrefix = 'This needs '
    private static readonly BodyAsk = '. Ask '
    private static readonly BodySuffix = ' to grant it. Nothing here was changed.'

    private readonly config: DeniedStateConfig

    public constructor(config: DeniedStateConfig)
    {
        super()
        this.config = config
        this.Build()
    }

    public get Heading(): string
    {
        return DeniedStatePanel.HeadingPrefix + this.config.what
    }

    public get BodyText(): string
    {
        return DeniedStatePanel.BodyPrefix + this.config.need
            + DeniedStatePanel.BodyAsk + (this.config.ask ?? DeniedStatePanel.DefaultAsk)
            + DeniedStatePanel.BodySuffix
    }

    private Build(): void
    {
        this.AddChild(this.Glyph(KitGlyph.Ban, PillTone.Neutral))
        this.AddChild(this.Text(this.Heading))
        this.AddChild(this.Text(this.BodyText))
    }
}
