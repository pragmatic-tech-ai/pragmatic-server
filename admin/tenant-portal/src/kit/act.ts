import { Button, ButtonVariant, ToolTipService } from '@pragmatic-tech-ai/mural/framework'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'

export enum ActVariant
{
    Primary = 'primary',
    Secondary = 'secondary',
    Danger = 'danger',
}

export interface ActInputs
{
    can: boolean
    need?: string
    onClick: () => void
    label: string
    variant?: ActVariant
    disabledReason?: string
}

// Permission-gated action button. When the caller lacks permission it stays
// VISIBLE but disabled, carrying the needed-role hint as its tooltip; it never hides.
export class Act extends Button
{
    private static readonly NeedTemplate = 'Requires role: '

    private readonly inputs: ActInputs
    private readonly reason: string | undefined

    public constructor(inputs: ActInputs)
    {
        super()
        this.inputs = inputs
        const text = new TextBlock()
        text.Text = inputs.label
        this.Content = text
        this.Variant = Act.Map(inputs.variant ?? ActVariant.Secondary)
        this.IsEnabled = inputs.can
        this.reason = inputs.can ? undefined : Act.Reason(inputs)
        if (this.reason !== undefined)
        {
            ToolTipService.SetToolTip(this, this.reason)
        }
        this.AddClickHandler(() => this.Fire())
    }

    // Test seam: whether the action is currently available.
    public get Enabled(): boolean
    {
        return this.IsEnabled
    }

    // Test seam: the need / disabled-reason hint shown when denied.
    public get DisabledHint(): string | undefined
    {
        return this.reason
    }

    // Test seam: simulate activation (gated exactly like a real click).
    public Press(): void
    {
        this.Fire()
    }

    private Fire(): void
    {
        if (this.inputs.can)
        {
            this.inputs.onClick()
        }
    }

    private static Reason(inputs: ActInputs): string | undefined
    {
        if (inputs.disabledReason !== undefined && inputs.need !== undefined)
        {
            return `${inputs.disabledReason} (${Act.NeedTemplate}${inputs.need})`
        }
        if (inputs.need !== undefined)
        {
            return Act.NeedTemplate + inputs.need
        }
        return inputs.disabledReason
    }

    private static Map(variant: ActVariant): ButtonVariant
    {
        switch (variant)
        {
            case ActVariant.Primary:
                return ButtonVariant.Primary
            case ActVariant.Danger:
                return ButtonVariant.Danger
            default:
                return ButtonVariant.Secondary
        }
    }
}
