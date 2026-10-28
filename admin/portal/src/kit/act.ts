import { ButtonVariant, ToolTipService } from '@pragmatic-tech-ai/mural/framework'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { KeyActivatedButton } from './key-activated-button.js'

export enum ActVariant
{
    Primary,
    Secondary,
    Danger,
}

export interface ActInputs
{
    can: boolean
    need?: string
    ask?: string
    disabledReason?: string
    onClick: () => void
    label: string
    variant?: ActVariant
}

// Permission-gated action button. When the caller lacks permission it stays
// VISIBLE but disabled, carrying the needed-role hint as its tooltip; it never hides.
export class Act extends KeyActivatedButton
{
    private static readonly NeedTemplate = 'Requires role: '
    private static readonly AskTemplate = '; ask '
    private static readonly OpenParen = ' ('
    private static readonly CloseParen = ')'

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

    protected override Activate(): void
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
        if (inputs.need === undefined)
        {
            return inputs.disabledReason
        }
        const ask = inputs.ask !== undefined ? Act.AskTemplate + inputs.ask : ''
        const need = Act.NeedTemplate + inputs.need + ask
        if (inputs.disabledReason !== undefined)
        {
            return inputs.disabledReason + Act.OpenParen + need + Act.CloseParen
        }
        return need
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
