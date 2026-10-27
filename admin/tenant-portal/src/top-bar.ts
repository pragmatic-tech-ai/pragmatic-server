import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Brush } from '@pragmatic-tech-ai/mural/visual-engine'
import { IdentityPlate } from './identity-plate.js'
import { UserMenu } from './user-menu.js'

export interface TopBarInputs
{
    plate: IdentityPlate
    userMenu: UserMenu
}

// Vertical host: the bar row (plate left, spacer, user menu right) above an empty BannerSlot
// that later specs fill with the quiet-hive banner. Bar surface: Bg1 (raised surface vs Bg0 paper rail).
export class TopBar extends StackPanel
{
    public static readonly SurfaceKey = 'Bg1'

    private readonly bar = new StackPanel()
    private readonly spacer = new StackPanel()
    private readonly bannerSlot = new StackPanel()
    private readonly plate: IdentityPlate
    private readonly userMenu: UserMenu

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

    // Empty container below the bar, above the content area; later specs add the banner here.
    public get BannerSlot(): StackPanel
    {
        return this.bannerSlot
    }

    public get BarSurface(): unknown
    {
        return this.bar.Fill
    }
}
