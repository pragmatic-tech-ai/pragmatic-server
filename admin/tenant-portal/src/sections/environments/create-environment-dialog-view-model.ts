import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { TenantApiError } from '../../tenant-api-client.js'
import { EnvType, Template, type EnvironmentDto } from '../../tenant-types.js'
import { AdminCapability } from '../../shell/admin-capability.js'
import { OptionViewModel } from '../../shell/option-view-model.js'
import { TenantDialogViewModel } from '../../shell/tenant-dialog-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'

// Create environment: only the fields the server takes (name, template,
// type). Create stays disabled until the name is valid and not already used
// by a listed environment; the server's 409 (a name taken meanwhile) reads
// the same as the local duplicate check.
export class CreateEnvironmentDialogViewModel extends TenantDialogViewModel<EnvironmentDto>
{
    public static readonly Title = 'Create environment'
    public static readonly FormatMessage = 'Use 3-31 lowercase letters, digits or hyphens, starting with a letter.'
    public static readonly DuplicateMessage = 'An environment with this name exists.'
    public static readonly FailureMessage = 'Could not create the environment. Please try again.'

    private static readonly NameProperty = 'Name'
    private static readonly NameErrorTextProperty = 'NameErrorText'
    private static readonly SelectedTemplateProperty = 'SelectedTemplate'
    private static readonly SelectedTypeProperty = 'SelectedType'
    private static readonly NamePattern = /^[a-z][a-z0-9-]{2,30}$/
    private static readonly DuplicateStatus = 409
    private static readonly DevBlankLabel = 'Blank development (dev-blank)'
    private static readonly DemoContosoLabel = 'Contoso demo (demo-contoso)'
    private static readonly RuntimePostgresLabel = 'Runtime with Postgres (runtime-postgres)'
    private static readonly DevelopmentLabel = 'Development'
    private static readonly RuntimeLabel = 'Runtime'

    private readonly templates = new ObservableCollection<OptionViewModel<Template>>()
    private readonly types = new ObservableCollection<OptionViewModel<EnvType>>()
    private readonly existingNames: ReadonlySet<string>
    private name = ''
    private selectedTemplate: OptionViewModel<Template>
    private selectedType: OptionViewModel<EnvType>

    public constructor(session: TenantSessionService, dialogs: DialogService, existingNames: readonly string[])
    {
        super(session, dialogs, AdminCapability.Environments)
        this.existingNames = new Set(existingNames)
        const C = CreateEnvironmentDialogViewModel
        this.selectedTemplate = new OptionViewModel(Template.DevBlank, C.DevBlankLabel)
        this.templates.Add(this.selectedTemplate)
        this.templates.Add(new OptionViewModel(Template.DemoContoso, C.DemoContosoLabel))
        this.templates.Add(new OptionViewModel(Template.RuntimePostgres, C.RuntimePostgresLabel))
        this.selectedType = new OptionViewModel(EnvType.Runtime, C.RuntimeLabel)
        this.types.Add(new OptionViewModel(EnvType.Development, C.DevelopmentLabel))
        this.types.Add(this.selectedType)
    }

    public get Name(): string
    {
        return this.name
    }

    public set Name(value: string)
    {
        const oldError = this.NameErrorText
        this.SetField(CreateEnvironmentDialogViewModel.NameProperty, this.name, value, v => { this.name = v })
        this.RaisePropertyChanged(CreateEnvironmentDialogViewModel.NameErrorTextProperty, oldError, this.NameErrorText)
    }

    // Why the typed name is not accepted; '' while empty or valid.
    public get NameErrorText(): string
    {
        const C = CreateEnvironmentDialogViewModel
        if (this.name.length === 0)
        {
            return ''
        }
        if (!C.NamePattern.test(this.name))
        {
            return C.FormatMessage
        }
        return this.existingNames.has(this.name) ? C.DuplicateMessage : ''
    }

    public get Templates(): ObservableCollection<OptionViewModel<Template>>
    {
        return this.templates
    }

    public get SelectedTemplate(): OptionViewModel<Template>
    {
        return this.selectedTemplate
    }

    public set SelectedTemplate(value: OptionViewModel<Template>)
    {
        if (value === undefined || value === null)
        {
            return
        }
        this.SetField(CreateEnvironmentDialogViewModel.SelectedTemplateProperty, this.selectedTemplate, value, v => { this.selectedTemplate = v })
    }

    public get Types(): ObservableCollection<OptionViewModel<EnvType>>
    {
        return this.types
    }

    public get SelectedType(): OptionViewModel<EnvType>
    {
        return this.selectedType
    }

    public set SelectedType(value: OptionViewModel<EnvType>)
    {
        if (value === undefined || value === null)
        {
            return
        }
        this.SetField(CreateEnvironmentDialogViewModel.SelectedTypeProperty, this.selectedType, value, v => { this.selectedType = v })
    }

    protected override get CanConfirm(): boolean
    {
        return CreateEnvironmentDialogViewModel.NamePattern.test(this.name) && !this.existingNames.has(this.name)
    }

    // A 401 passes through (the base expires the session); a 409 reads as
    // the duplicate message; anything else as the generic failure.
    protected override async SubmitCore(): Promise<EnvironmentDto>
    {
        const C = CreateEnvironmentDialogViewModel
        try
        {
            return await this.Session.Client.CreateEnvironment({ name: this.name, template: this.selectedTemplate.Value, type: this.selectedType.Value })
        }
        catch (e)
        {
            if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
            {
                throw e
            }
            const duplicate = e instanceof TenantApiError && e.Status === C.DuplicateStatus
            throw new Error(duplicate ? C.DuplicateMessage : C.FailureMessage)
        }
    }
}
