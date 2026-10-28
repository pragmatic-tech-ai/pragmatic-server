import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import type { Act } from './act.js'
import { KeyActivatedButton } from './key-activated-button.js'

export interface PageTab
{
    label: string
    onSelect: () => void
}

export interface PageHeaderInputs
{
    breadcrumb: readonly string[]
    title: string
    sub?: string
    primaryAction?: Act
    tabs?: readonly PageTab[]
}

// Page header: breadcrumb, title row (title + optional primary action), optional sub, optional tabs.
export class PageHeader extends StackPanel
{
    private static readonly Separator = ' / '
    // Role marker: Mural has no ARIA bridge, so the active tab is exposed as a Tag.
    public static readonly CurrentRole = 'current'

    private readonly inputs: PageHeaderInputs
    private readonly tabControls: KeyActivatedButton[] = []

    public constructor(inputs: PageHeaderInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Vertical
        this.Build()
    }

    // Test seam: the breadcrumb trail as text.
    public get BreadcrumbText(): string
    {
        return this.inputs.breadcrumb.join(PageHeader.Separator)
    }

    // Test seam: the page title.
    public get Title(): string
    {
        return this.inputs.title
    }

    // Test seam: the tab buttons (empty when no tabs were provided).
    public get TabControls(): readonly KeyActivatedButton[]
    {
        return this.tabControls
    }

    // Marks exactly one tab with the current role; clears the others.
    public SetActiveTab(index: number): void
    {
        this.tabControls.forEach((tab, i) =>
        {
            tab.Tag = i === index ? PageHeader.CurrentRole : null
        })
    }

    private Build(): void
    {
        if (this.inputs.breadcrumb.length > 0)
        {
            this.AddChild(PageHeader.Text(this.BreadcrumbText))
        }
        const titleRow = new StackPanel()
        titleRow.Orientation = Orientation.Horizontal
        titleRow.AddChild(PageHeader.Text(this.inputs.title))
        if (this.inputs.primaryAction !== undefined)
        {
            titleRow.AddChild(this.inputs.primaryAction)
        }
        this.AddChild(titleRow)
        if (this.inputs.sub !== undefined && this.inputs.sub !== '')
        {
            this.AddChild(PageHeader.Text(this.inputs.sub))
        }
        if (this.inputs.tabs !== undefined && this.inputs.tabs.length > 0)
        {
            this.AddChild(this.BuildTabs(this.inputs.tabs))
        }
    }

    private BuildTabs(tabs: readonly PageTab[]): StackPanel
    {
        const row = new StackPanel()
        row.Orientation = Orientation.Horizontal
        for (const tab of tabs)
        {
            const button = new KeyActivatedButton(tab.onSelect)
            button.Content = PageHeader.Text(tab.label)
            this.tabControls.push(button)
            row.AddChild(button)
        }
        return row
    }

    private static Text(value: string): TextBlock
    {
        const text = new TextBlock()
        text.Text = value
        return text
    }
}
