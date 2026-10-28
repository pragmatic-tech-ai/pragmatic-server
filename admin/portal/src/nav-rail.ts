import { Icon, Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Brush } from '@pragmatic-tech-ai/mural/visual-engine'
import { IconCatalog } from './kit/icon-catalog.js'
import { InternalTag } from './kit/internal-tag.js'
import { KeyActivatedButton } from './kit/key-activated-button.js'
import { NavItem, NavModel, PaSection } from './nav-model.js'

// Paper sidebar: brand + Internal tag, then grouped selectable section rows.
export class NavRail extends StackPanel
{
    public static readonly BrandText = 'Platform Admin'
    // Role marker: Mural has no ARIA bridge, so the current item is exposed as a Tag.
    public static readonly CurrentRole = 'current'
    public static readonly NavRole = 'nav'
    public static readonly NavLabel = 'Primary'
    // Pragmatic theme surface key: Bg0 is the warm off-white page surface.
    public static readonly SurfaceKey = 'Bg0'

    private readonly onSelect: (section: PaSection) => void
    private readonly rows = new Map<PaSection, KeyActivatedButton>()
    private active: PaSection | undefined

    public constructor(onSelect: (section: PaSection) => void, active?: PaSection)
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

    public get Active(): PaSection | undefined
    {
        return this.active
    }

    // Test seam: one row per section.
    public get Rows(): ReadonlyMap<PaSection, KeyActivatedButton>
    {
        return this.rows
    }

    // Runs the same path a row click runs (also the test seam).
    public Select(section: PaSection): void
    {
        this.onSelect(section)
    }

    // Mural enters its Tab order only from a focused control, so the boot path focuses the active row.
    public FocusActive(): void
    {
        if (this.active !== undefined)
        {
            this.rows.get(this.active)?.Focus()
        }
    }

    public SetActive(section: PaSection): void
    {
        this.active = NavModel.ActiveFor(section)
        for (const [rowSection, button] of this.rows)
        {
            button.Tag = rowSection === this.active ? NavRail.CurrentRole : null
        }
    }

    private Build(): void
    {
        const brandRow = new StackPanel()
        brandRow.Orientation = Orientation.Horizontal
        const brand = new TextBlock()
        brand.Text = NavRail.BrandText
        brandRow.AddChild(brand)
        brandRow.AddChild(new InternalTag())
        this.AddChild(brandRow)
        for (const group of NavModel.Groups)
        {
            if (group.heading !== undefined)
            {
                const heading = new TextBlock()
                heading.Text = group.heading
                this.AddChild(heading)
            }
            for (const item of group.items)
            {
                const button = this.MakeRow(item)
                this.rows.set(item.Section, button)
                this.AddChild(button)
            }
        }
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
        // Mural Buttons do not take focus on click, so activation moves focus here.
        const button: KeyActivatedButton = new KeyActivatedButton(() =>
        {
            this.Select(item.Section)
            button.Focus()
        })
        button.Content = content
        return button
    }
}
