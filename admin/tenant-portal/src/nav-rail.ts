import { Icon, Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { IconCatalog } from './kit/icon-catalog.js'
import { NavItem, NavModel, NavSection } from './nav-model.js'

// Paper sidebar: brand header, six selectable section rows, footer note.
export class NavRail extends StackPanel
{
    public static readonly BrandText = 'Tenant Admin'
    public static readonly FooterText = 'Runs inside your hive. Manages one tenant.'
    // Role marker: Mural has no ARIA bridge, so the current item is exposed as a Tag.
    public static readonly CurrentRole = 'current'

    private readonly onSelect: (section: NavSection) => void
    private readonly rows = new Map<NavSection, Button>()
    private active: NavSection | undefined

    public constructor(onSelect: (section: NavSection) => void, active?: NavSection)
    {
        super()
        this.onSelect = onSelect
        this.Orientation = Orientation.Vertical
        this.Build()
        if (active !== undefined)
        {
            this.SetActive(active)
        }
    }

    public get Active(): NavSection | undefined
    {
        return this.active
    }

    public SetActive(section: NavSection): void
    {
        this.active = NavModel.ActiveFor(section)
        for (const [rowSection, button] of this.rows)
        {
            button.Tag = rowSection === this.active ? NavRail.CurrentRole : null
        }
    }

    private Build(): void
    {
        const brand = new TextBlock()
        brand.Text = NavRail.BrandText
        this.AddChild(brand)
        for (const item of NavModel.Items)
        {
            const button = this.MakeRow(item)
            this.rows.set(item.Section, button)
            this.AddChild(button)
        }
        const footer = new TextBlock()
        footer.Text = NavRail.FooterText
        this.AddChild(footer)
    }

    private MakeRow(item: NavItem): Button
    {
        const content = new StackPanel()
        content.Orientation = Orientation.Horizontal
        const icon = new Icon()
        icon.Source = IconCatalog.Definition(item.Glyph)
        icon.Recolor = true
        const text = new TextBlock()
        text.Text = item.Label
        content.AddChild(icon)
        content.AddChild(text)
        const button = new Button()
        button.Content = content
        button.AddClickHandler(() => this.onSelect(item.Section))
        return button
    }
}
