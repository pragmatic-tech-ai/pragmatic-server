import { StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ButtonVariant, Dialog, DialogAction } from '@pragmatic-tech-ai/mural/framework'
import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'

export enum ConfirmTone
{
    Danger = 'danger',
    Primary = 'primary',
}

export interface ConfirmDialogInputs
{
    title: string
    body?: string
    consequences?: string[]
    confirmName?: string
    actionLabel: string
    tone?: ConfirmTone
    onConfirm: () => void
    onClose: () => void
}

// Name-to-confirm destructive dialog composed on Mural's Dialog. The confirm
// action stays disabled until the typed text EXACTLY equals confirmName.
export class ConfirmDialog extends Dialog
{
    private static readonly TypeTemplate = 'Type {name} to confirm'
    private static readonly NameToken = '{name}'
    private static readonly CancelLabel = 'Cancel'
    private static readonly BulletPrefix = '- '

    private readonly inputs: ConfirmDialogInputs
    private readonly box: TextBox | undefined
    private readonly confirmCommand: RelayCommand
    private readonly cancelCommand: RelayCommand
    private readonly bodyLines: string[] = []

    public constructor(inputs: ConfirmDialogInputs)
    {
        super()
        this.inputs = inputs
        this.Title = inputs.title
        this.confirmCommand = new RelayCommand(() => this.RunConfirm(), () => this.Matches())
        this.cancelCommand = new RelayCommand(() => inputs.onClose())
        const panel = new StackPanel()
        if (inputs.body !== undefined)
        {
            panel.AddChild(this.Line(inputs.body))
        }
        for (const consequence of inputs.consequences ?? [])
        {
            panel.AddChild(this.Line(ConfirmDialog.BulletPrefix + consequence))
        }
        if (inputs.confirmName !== undefined)
        {
            panel.AddChild(this.Line(ConfirmDialog.TypeTemplate.replace(ConfirmDialog.NameToken, inputs.confirmName)))
            this.box = new TextBox()
            this.box.PropertyChanged(TextBox.TextKey).subscribe(() => this.confirmCommand.RaiseCanExecuteChanged())
            panel.AddChild(this.box)
        }
        this.Content = panel
        const confirmVariant = (inputs.tone ?? ConfirmTone.Danger) === ConfirmTone.Danger
            ? ButtonVariant.Danger
            : ButtonVariant.Primary
        this.Actions = [
            new DialogAction(ConfirmDialog.CancelLabel, this.cancelCommand, ButtonVariant.Secondary),
            new DialogAction(inputs.actionLabel, this.confirmCommand, confirmVariant),
        ]
        this.AddCloseRequestedListener(() => inputs.onClose())
    }

    // Test seam: whether the confirm action is currently enabled.
    public get ConfirmEnabled(): boolean
    {
        return this.confirmCommand.CanExecute()
    }

    // Test seam: the lines of body/consequences/prompt text rendered.
    public get Lines(): readonly string[]
    {
        return this.bodyLines
    }

    // Test seam: type into the confirmation box.
    public SetTyped(text: string): void
    {
        if (this.box !== undefined)
        {
            this.box.Text = text
        }
    }

    // Test seam: click Confirm (gated by CanExecute like the real button).
    public Confirm(): void
    {
        if (this.confirmCommand.CanExecute())
        {
            this.confirmCommand.Execute()
        }
    }

    // Test seam: click Cancel.
    public Cancel(): void
    {
        this.cancelCommand.Execute()
    }

    private Matches(): boolean
    {
        if (this.inputs.confirmName === undefined)
        {
            return true
        }
        return this.box !== undefined && this.box.Text === this.inputs.confirmName
    }

    private RunConfirm(): void
    {
        this.inputs.onConfirm()
        this.inputs.onClose()
    }

    private Line(text: string): TextBlock
    {
        this.bodyLines.push(text)
        const block = new TextBlock()
        block.Text = text
        return block
    }
}
