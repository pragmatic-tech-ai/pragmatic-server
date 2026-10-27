import { Icon, Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { ToolTipService } from '@pragmatic-tech-ai/mural/framework'
import { IconCatalog, KitGlyph } from './kit/icon-catalog.js'

export interface IdentityPlateInputs
{
    org?: string
    tenant: string
    hive: string
}

// Non-interactive chip: "org / [users] tenant [hard-drive] hive". It is a label only:
// no Button or other clickable lives in it. The org text and its "/" are omitted when org is empty.
export class IdentityPlate extends StackPanel
{
    public static readonly HoverTitle = 'This console manages one tenant in one hive'
    public static readonly Separator = '/'
    // The theme ships no mono resource, so the hive id names a monospace family directly.
    public static readonly MonoFontFamily = 'Consolas, monospace'

    private readonly inputs: IdentityPlateInputs

    public constructor(inputs: IdentityPlateInputs)
    {
        super()
        this.inputs = inputs
        this.Orientation = Orientation.Horizontal
        ToolTipService.SetToolTip(this, IdentityPlate.HoverTitle)
        this.Build()
    }

    private Build(): void
    {
        const org = this.inputs.org
        if (org !== undefined && org !== '')
        {
            this.AddChild(IdentityPlate.MakeText(org))
            this.AddChild(IdentityPlate.MakeText(IdentityPlate.Separator))
        }
        this.AddChild(IdentityPlate.MakeIcon(KitGlyph.Users))
        this.AddChild(IdentityPlate.MakeText(this.inputs.tenant))
        this.AddChild(IdentityPlate.MakeIcon(KitGlyph.HardDrive))
        const hive = IdentityPlate.MakeText(this.inputs.hive)
        hive.FontFamily = IdentityPlate.MonoFontFamily
        this.AddChild(hive)
    }

    private static MakeText(text: string): TextBlock
    {
        const block = new TextBlock()
        block.Text = text
        return block
    }

    private static MakeIcon(glyph: KitGlyph): Icon
    {
        const icon = new Icon()
        icon.Source = IconCatalog.Definition(glyph)
        icon.Recolor = true
        return icon
    }
}
