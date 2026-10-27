import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button, ButtonVariant } from '@pragmatic-tech-ai/mural/framework'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'

export interface TabEntry
{
    label: string
    content: Visual
}

export interface TabsInputs
{
    entries: TabEntry[]
    onSelect?: (index: number) => void
}

// A horizontal strip of tab buttons above a single content host showing the active entry.
// The active tab wears the Primary button variant (a fill-and-weight difference, not hue
// alone); IsActiveTab is the test seam that reads it.
export class Tabs extends StackPanel
{
    private readonly inputs: TabsInputs
    private readonly buttons: Button[] = []
    private readonly host: StackPanel
    private active = 0

    public constructor(inputs: TabsInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Vertical
        this.host = new StackPanel()
        this.host.Orientation = Orientation.Vertical
        this.Build()
    }

    // Test seam: index of the visible tab.
    public get ActiveIndex(): number
    {
        return this.active
    }

    // Test seam: the content currently shown.
    public get ActiveContent(): Visual
    {
        return this.inputs.entries[this.active].content
    }

    // Test seam: the host panel holding exactly the active content.
    public get ContentHost(): StackPanel
    {
        return this.host
    }

    // Test seam: whether the tab at index is rendered as the active one.
    public IsActiveTab(index: number): boolean
    {
        return this.buttons[index].Variant === ButtonVariant.Primary
    }

    public Select(index: number): void
    {
        if (index === this.active || index < 0 || index >= this.inputs.entries.length)
        {
            return
        }
        this.active = index
        this.Refresh()
        this.inputs.onSelect?.(index)
    }

    private Build(): void
    {
        const strip = new StackPanel()
        strip.Orientation = Orientation.Horizontal
        this.inputs.entries.forEach((entry, i) =>
        {
            const button = new Button()
            const text = new TextBlock()
            text.Text = entry.label
            button.Content = text
            button.AddClickHandler(() => this.Select(i))
            this.buttons.push(button)
            strip.AddChild(button)
        })
        this.AddChild(strip)
        this.AddChild(this.host)
        this.Refresh()
    }

    private Refresh(): void
    {
        this.buttons.forEach((button, i) =>
        {
            button.Variant = i === this.active ? ButtonVariant.Primary : ButtonVariant.Secondary
        })
        for (const child of [...this.host.Children])
        {
            this.host.RemoveChild(child)
        }
        if (this.inputs.entries.length > 0)
        {
            this.host.AddChild(this.ActiveContent)
        }
    }
}
