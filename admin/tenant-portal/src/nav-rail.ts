import { Icon, Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Brush } from '@pragmatic-tech-ai/mural/visual-engine'
import { IconCatalog } from './kit/icon-catalog.js'
import { KeyActivatedButton } from './kit/key-activated-button.js'
import { NavItem, NavModel, NavSection } from './nav-model.js'

// Paper sidebar: brand header, six selectable section rows, footer note.
export class NavRail extends StackPanel
{
    public static readonly BrandText = 'Tenant Admin'
    public static readonly FooterText = 'Runs inside your hive. Manages one tenant.'
    // Role marker: Mural has no ARIA bridge, so the current item is exposed as a Tag.
    public static readonly CurrentRole = 'current'
    // Primary-navigation landmark seam (the nav / aria-label analog). Not real SR semantics;
    // a later screen-reader pass wires these to the host element.
    public static readonly NavRole = 'nav'
    public static readonly NavLabel = 'Primary'
    // Pragmatic theme surface key: Bg0 is the warm off-white page surface (the "paper" sidebar).
    public static readonly SurfaceKey = 'Bg0'

    private readonly onSelect: (section: NavSection) => void
    private readonly rows = new Map<NavSection, KeyActivatedButton>()
    private active: NavSection | undefined

    public constructor(onSelect: (section: NavSection) => void, active?: NavSection)
    {
        super()
        this.onSelect = onSelect
        this.Orientation = Orientation.Vertical
        this.Tag = NavRail.NavRole
        this.Fill = Application.ResolveDefaultResource<Brush>(NavRail.SurfaceKey)
        this.Build()
        if (active !== undefined)
        {
            this.SetActive(active)
        }
    }

    public get Role(): string
    {
        return NavRail.NavRole
    }

    public get Label(): string
    {
        return NavRail.NavLabel
    }

    public get Active(): NavSection | undefined
    {
        return this.active
    }

    // Runs the same path a row click runs (also the test seam).
    public Select(section: NavSection): void
    {
        this.onSelect(section)
    }

    // Initial keyboard focus: Mural enters its Tab order only from a focused control, so the boot path focuses the active row.
    public FocusActive(): void
    {
        if (this.active !== undefined)
        {
            this.rows.get(this.active)?.Focus()
        }
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

    private MakeRow(item: NavItem): KeyActivatedButton
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
        // Mural Buttons do not take focus on click, so activation moves focus here: the keyboard stays on the row it chose.
        const button: KeyActivatedButton = new KeyActivatedButton(() =>
        {
            this.Select(item.Section)
            button.Focus()
        })
        button.Content = content
        return button
    }
}
