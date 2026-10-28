import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button, ButtonVariant } from '@pragmatic-tech-ai/mural/framework'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'

export interface DrawerInputs
{
    title: string
    body: Visual
    open: boolean
    closeLabel: string
    onClose: () => void
}

// Slide-over style panel: header (title + close button) above the body, present only while open.
export class Drawer extends StackPanel
{
    private readonly inputs: DrawerInputs
    private readonly bodyHost: StackPanel
    private open: boolean

    public constructor(inputs: DrawerInputs)
    {
        super()
        this.inputs = inputs
        this.open = inputs.open
        this.Orientation = Orientation.Vertical
        this.bodyHost = new StackPanel()
        this.bodyHost.Orientation = Orientation.Vertical
        this.Rebuild()
    }

    public get Open(): boolean
    {
        return this.open
    }

    public get BodyHost(): StackPanel
    {
        return this.bodyHost
    }

    public SetOpen(open: boolean): void
    {
        this.open = open
        this.Rebuild()
    }

    public Toggle(): void
    {
        this.SetOpen(!this.open)
    }

    private Rebuild(): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
        for (const child of [...this.bodyHost.Children])
        {
            this.bodyHost.RemoveChild(child)
        }
        if (!this.open)
        {
            return
        }
        const header = new StackPanel()
        header.Orientation = Orientation.Horizontal
        const title = new TextBlock()
        title.Text = this.inputs.title
        header.AddChild(title)
        const close = new Button()
        const caption = new TextBlock()
        caption.Text = this.inputs.closeLabel
        close.Content = caption
        close.Variant = ButtonVariant.Secondary
        close.AddClickHandler(() => this.inputs.onClose())
        header.AddChild(close)
        this.bodyHost.AddChild(this.inputs.body)
        this.AddChild(header)
        this.AddChild(this.bodyHost)
    }
}
