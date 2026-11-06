import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { TenantApiError } from '../../tenant-api-client.js'
import type { GraphDto } from '../../tenant-types.js'
import { AdminCapability } from '../../shell/admin-capability.js'
import { TenantDialogViewModel } from '../../shell/tenant-dialog-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'

// New graph in a Development environment: a name and a description. Create
// stays disabled until the name follows the server's rule and is not one the
// tab already lists. Any server refusal, including a 409 for a name taken
// meanwhile, shows the route's own sentence; a request that never got an
// answer reads as the generic failure.
export class CreateGraphDialogViewModel extends TenantDialogViewModel<GraphDto>
{
    public static readonly Title = 'New graph'
    public static readonly FormatMessage = 'Use lowercase letters, digits and hyphens, starting with a letter or digit.'
    public static readonly DuplicateMessage = 'A graph with this name exists in this environment.'
    public static readonly FailureMessage = 'Could not create the graph. Please try again.'
    // Mirrors the server's DevGraphService.GraphNamePattern.
    public static readonly NamePattern = /^[a-z0-9][a-z0-9-]*$/

    private static readonly NoText = ''
    private static readonly NameProperty = 'Name'
    private static readonly DescriptionProperty = 'Description'
    private static readonly NameErrorTextProperty = 'NameErrorText'

    private readonly existingNames: ReadonlySet<string>
    private name = ''
    private description = ''

    public constructor(session: TenantSessionService, dialogs: DialogService, private readonly environment: string, existingNames: readonly string[])
    {
        super(session, dialogs, AdminCapability.Environments)
        this.existingNames = new Set(existingNames)
    }

    // The environment the graph is created in.
    public get Environment(): string
    {
        return this.environment
    }

    public get Name(): string
    {
        return this.name
    }

    public set Name(value: string)
    {
        const oldError = this.NameErrorText
        this.SetField(CreateGraphDialogViewModel.NameProperty, this.name, value, v => { this.name = v })
        this.RaisePropertyChanged(CreateGraphDialogViewModel.NameErrorTextProperty, oldError, this.NameErrorText)
    }

    public get Description(): string
    {
        return this.description
    }

    public set Description(value: string)
    {
        this.SetField(CreateGraphDialogViewModel.DescriptionProperty, this.description, value, v => { this.description = v })
    }

    // Why the typed name is not accepted; '' while empty or valid.
    public get NameErrorText(): string
    {
        const C = CreateGraphDialogViewModel
        if (this.name.length === 0)
        {
            return C.NoText
        }
        if (!C.NamePattern.test(this.name))
        {
            return C.FormatMessage
        }
        return this.existingNames.has(this.name) ? C.DuplicateMessage : C.NoText
    }

    protected override get CanConfirm(): boolean
    {
        return CreateGraphDialogViewModel.NamePattern.test(this.name) && !this.existingNames.has(this.name)
    }

    // A 401 passes through (the base expires the session); any other server
    // answer (a 409 included) shows the route's sentence; no answer reads as
    // the generic failure.
    protected override async SubmitCore(): Promise<GraphDto>
    {
        try
        {
            return await this.Session.Client.CreateGraph(this.environment, { name: this.name, description: this.description })
        }
        catch (e)
        {
            if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
            {
                throw e
            }
            if (e instanceof TenantApiError)
            {
                throw new Error(e.message)
            }
            throw new Error(CreateGraphDialogViewModel.FailureMessage)
        }
    }
}
