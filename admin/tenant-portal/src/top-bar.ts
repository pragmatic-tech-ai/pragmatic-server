import { Icon, Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Brush } from '@pragmatic-tech-ai/mural/visual-engine'
import { IdentityPlate } from './identity-plate.js'
import { Act, ActVariant } from './kit/act.js'
import { IconCatalog, KitGlyph } from './kit/icon-catalog.js'
import { UserMenu } from './user-menu.js'

export interface TopBarInputs
{
    plate: IdentityPlate
    userMenu: UserMenu
    onActivity: () => void
}

// Vertical host: the bar row (plate left, spacer, user menu right) above an empty BannerSlot
// that later specs fill with the quiet-hive banner. Bar surface: Bg1 (raised surface vs Bg0 paper rail).
export class TopBar extends StackPanel
{
    public static readonly SurfaceKey = 'Bg1'
    public static readonly ActivityLabel = 'Activity'
    private static readonly InitialCount = 0

    private readonly bar = new StackPanel()
    private readonly spacer = new StackPanel()
    private readonly bannerSlot = new StackPanel()
    private readonly plate: IdentityPlate
    private readonly userMenu: UserMenu
    private readonly activityToggle: Act
    private readonly activityCount = new TextBlock()

    public constructor(inputs: TopBarInputs)
    {
        super()
        this.plate = inputs.plate
        this.userMenu = inputs.userMenu
        this.Orientation = Orientation.Vertical
        this.bar.Orientation = Orientation.Horizontal
        this.bar.Fill = Application.ResolveDefaultResource<Brush>(TopBar.SurfaceKey)
        this.bar.AddChild(this.plate)
        this.bar.AddChild(this.spacer)
        this.activityToggle = new Act({ can: true, label: TopBar.ActivityLabel, variant: ActVariant.Secondary, onClick: inputs.onActivity })
        const icon = new Icon()
        icon.Source = IconCatalog.Definition(KitGlyph.History)
        icon.Recolor = true
        this.SetActivityCount(TopBar.InitialCount)
        this.bar.AddChild(icon)
        this.bar.AddChild(this.activityToggle)
        this.bar.AddChild(this.activityCount)
        this.bar.AddChild(this.userMenu)
        this.AddChild(this.bar)
        this.AddChild(this.bannerSlot)
    }

    public get Plate(): IdentityPlate
    {
        return this.plate
    }

    public get UserMenuControl(): UserMenu
    {
        return this.userMenu
    }

    public get ActivityToggle(): Act
    {
        return this.activityToggle
    }

    public get ActivityCountText(): string
    {
        return this.activityCount.Text
    }

    public SetActivityCount(count: number): void
    {
        this.activityCount.Text = String(count)
    }

    // Empty container below the bar, above the content area; later specs add the banner here.
    public get BannerSlot(): StackPanel
    {
        return this.bannerSlot
    }

    public get BarSurface(): Brush | undefined
    {
        return this.bar.Fill
    }
}
