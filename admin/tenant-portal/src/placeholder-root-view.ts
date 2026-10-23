import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'

// Temporary root view so the empty app boots; replaced by TenantApp.
export class PlaceholderRootView extends StackPanel
{
    public static readonly TitleText = 'Pragmatic Tenant Admin'

    public constructor()
    {
        super()
        this.Orientation = Orientation.Vertical
        const title = new TextBlock()
        title.Text = PlaceholderRootView.TitleText
        this.AddChild(title)
    }
}
