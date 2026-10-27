import { StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Button, ButtonVariant, ComboBox, Dialog, DialogAction } from '@pragmatic-tech-ai/mural/framework'
import { RelayCommand, type Visual } from '@pragmatic-tech-ai/mural/runtime'
import { TenantApiError } from './tenant-api-client.js'
import { EnvType, Template, type EnvironmentDto, type IEnvironmentsSource } from './tenant-types.js'

// Create-environment form composed on Mural's Dialog. Only real server fields are
// offered (name, template, type); Create stays disabled until the name is valid and
// unique, and while a submit is in flight. The dialog never closes itself on the
// screen: it raises its dismiss listeners (Cancel, close button, success) and the
// owner removes it.
export class CreateEnvironmentDialog extends Dialog
{
    private static readonly DialogTitle = 'Create environment'
    private static readonly Reassurance = 'Runs in your hive. It takes a few minutes; you can leave this page.'
    private static readonly NameLabel = 'Name'
    private static readonly TemplateLabel = 'Template'
    private static readonly TypeLabel = 'Type'
    private static readonly CancelLabel = 'Cancel'
    private static readonly CreateLabel = 'Create environment'
    private static readonly NameRegex = /^[a-z][a-z0-9-]{2,30}$/
    private static readonly FormatMessage = 'Use 3-31 lowercase letters, digits or hyphens, starting with a letter.'
    private static readonly DuplicateMessage = 'An environment with this name exists.'
    private static readonly FailureMessage = 'Could not create the environment. Please try again.'
    private static readonly DuplicateStatus = 409
    private static readonly NoText = ''
    private static readonly TemplateLabels: ReadonlyMap<Template, string> = new Map([
        [Template.DevBlank, 'Blank development (dev-blank)'],
        [Template.DemoContoso, 'Contoso demo (demo-contoso)'],
        [Template.RuntimePostgres, 'Runtime with Postgres (runtime-postgres)'],
    ])
    private static readonly TypeLabels: ReadonlyMap<EnvType, string> = new Map([
        [EnvType.Development, 'Development'],
        [EnvType.Runtime, 'Runtime'],
    ])

    private readonly source: IEnvironmentsSource
    private readonly existingNames: readonly string[]
    private readonly onCreated: (env: EnvironmentDto) => void
    private readonly nameBox = new TextBox()
    private readonly templateBox = new ComboBox()
    private readonly typeBox = new ComboBox()
    private readonly errorBlock = new TextBlock()
    private readonly createCommand: RelayCommand
    private readonly cancelCommand: RelayCommand
    private readonly dismissListeners: Array<() => void> = []
    private template: Template = Template.DevBlank
    private type: EnvType = EnvType.Runtime
    private submitting = false
    private dismissed = false
    private errorText: string | undefined

    public constructor(source: IEnvironmentsSource, existingNames: readonly string[], onCreated: (env: EnvironmentDto) => void)
    {
        super()
        this.source = source
        this.existingNames = existingNames
        this.onCreated = onCreated
        this.Title = CreateEnvironmentDialog.DialogTitle
        this.createCommand = new RelayCommand(() => void this.Submit(), () => this.CreateEnabled)
        this.cancelCommand = new RelayCommand(() => this.Dismiss())

        const panel = new StackPanel()
        panel.AddChild(CreateEnvironmentDialog.Line(CreateEnvironmentDialog.Reassurance))
        panel.AddChild(CreateEnvironmentDialog.Line(CreateEnvironmentDialog.NameLabel))
        this.nameBox.PropertyChanged(TextBox.TextKey).subscribe(() => this.Revalidate())
        panel.AddChild(this.nameBox)
        panel.AddChild(this.errorBlock)
        panel.AddChild(CreateEnvironmentDialog.Line(CreateEnvironmentDialog.TemplateLabel))
        this.templateBox.Items = [...CreateEnvironmentDialog.TemplateLabels.values()]
        this.templateBox.SelectedItem = CreateEnvironmentDialog.TemplateLabels.get(this.template)
        this.templateBox.AddSelectionChangedListener(() => this.OnTemplatePicked())
        panel.AddChild(this.templateBox)
        panel.AddChild(CreateEnvironmentDialog.Line(CreateEnvironmentDialog.TypeLabel))
        this.typeBox.Items = [...CreateEnvironmentDialog.TypeLabels.values()]
        this.typeBox.SelectedItem = CreateEnvironmentDialog.TypeLabels.get(this.type)
        this.typeBox.AddSelectionChangedListener(() => this.OnTypePicked())
        panel.AddChild(this.typeBox)
        this.Content = panel
        this.Actions = [
            new DialogAction(CreateEnvironmentDialog.CancelLabel, this.cancelCommand, ButtonVariant.Secondary),
            new DialogAction(CreateEnvironmentDialog.CreateLabel, this.createCommand, ButtonVariant.Primary),
        ]
        this.AddCloseRequestedListener(() => this.Dismiss())
        this.AddLoadedListener(() => this.SyncCreateButton())
    }

    // Test seam: whether Create is currently available.
    public get CreateEnabled(): boolean
    {
        return !this.submitting && this.NameValid()
    }

    // Test seam: the inline error currently shown, if any.
    public get Error(): string | undefined
    {
        return this.errorText
    }

    public get SelectedTemplate(): Template
    {
        return this.template
    }

    public get SelectedType(): EnvType
    {
        return this.type
    }

    // True once the dialog asked its owner to remove it.
    public get Dismissed(): boolean
    {
        return this.dismissed
    }

    // The owner subscribes to be told when the dialog wants to go away.
    public AddDismissListener(listener: () => void): void
    {
        this.dismissListeners.push(listener)
    }

    // Test seam: type into the name box and revalidate.
    public SetName(name: string): void
    {
        this.nameBox.Text = name
        this.Revalidate()
    }

    public SetTemplate(template: Template): void
    {
        this.template = template
        this.templateBox.SelectedItem = CreateEnvironmentDialog.TemplateLabels.get(template)
    }

    public SetType(type: EnvType): void
    {
        this.type = type
        this.typeBox.SelectedItem = CreateEnvironmentDialog.TypeLabels.get(type)
    }

    // Runs the same path as clicking Create. A 401 is shown as the generic failure.
    public async Submit(): Promise<void>
    {
        if (!this.CreateEnabled)
        {
            return
        }
        this.submitting = true
        this.Refresh()
        try
        {
            const env = await this.source.CreateEnvironment({ name: this.nameBox.Text, template: this.template, type: this.type })
            this.onCreated(env)
            this.Dismiss()
        }
        catch (err)
        {
            const duplicate = err instanceof TenantApiError && err.Status === CreateEnvironmentDialog.DuplicateStatus
            this.errorText = duplicate ? CreateEnvironmentDialog.DuplicateMessage : CreateEnvironmentDialog.FailureMessage
        }
        finally
        {
            this.submitting = false
            this.Refresh()
        }
    }

    private NameValid(): boolean
    {
        const name = this.nameBox.Text
        return CreateEnvironmentDialog.NameRegex.test(name) && !this.existingNames.includes(name)
    }

    private Revalidate(): void
    {
        const name = this.nameBox.Text
        if (name === CreateEnvironmentDialog.NoText)
        {
            this.errorText = undefined
        }
        else if (!CreateEnvironmentDialog.NameRegex.test(name))
        {
            this.errorText = CreateEnvironmentDialog.FormatMessage
        }
        else if (this.existingNames.includes(name))
        {
            this.errorText = CreateEnvironmentDialog.DuplicateMessage
        }
        else
        {
            this.errorText = undefined
        }
        this.Refresh()
    }

    private OnTemplatePicked(): void
    {
        for (const [value, label] of CreateEnvironmentDialog.TemplateLabels)
        {
            if (label === this.templateBox.SelectedItem)
            {
                this.template = value
            }
        }
    }

    private OnTypePicked(): void
    {
        for (const [value, label] of CreateEnvironmentDialog.TypeLabels)
        {
            if (label === this.typeBox.SelectedItem)
            {
                this.type = value
            }
        }
    }

    private Refresh(): void
    {
        this.errorBlock.Text = this.errorText ?? CreateEnvironmentDialog.NoText
        this.createCommand.RaiseCanExecuteChanged()
        this.SyncCreateButton()
    }

    // Mural's Button gates clicks on CanExecute but does not dim itself, so mirror
    // the command state onto the rendered Create button.
    private SyncCreateButton(): void
    {
        const button = CreateEnvironmentDialog.FindButton(this, this.createCommand)
        if (button !== undefined)
        {
            button.IsEnabled = this.CreateEnabled
        }
    }

    private Dismiss(): void
    {
        this.dismissed = true
        for (const listener of this.dismissListeners)
        {
            listener()
        }
    }

    private static FindButton(root: Visual, command: RelayCommand): Button | undefined
    {
        if (root instanceof Button && root.Command === command)
        {
            return root
        }
        for (const child of (root as unknown as { visualChildren?: readonly Visual[] }).visualChildren ?? [])
        {
            const found = CreateEnvironmentDialog.FindButton(child, command)
            if (found !== undefined)
            {
                return found
            }
        }
        return undefined
    }

    private static Line(text: string): TextBlock
    {
        const block = new TextBlock()
        block.Text = text
        return block
    }
}
