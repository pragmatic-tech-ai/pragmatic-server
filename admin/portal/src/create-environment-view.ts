import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ComboBox } from '@pragmatic-tech-ai/mural/framework'
import type { ControlPlaneClient } from './api-client.js'
import type { IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// ComboBox item: Mural's collapsed selection text reads Label/Name/Text only,
// so the template title is carried as Label alongside the id.
export class TemplateOption
{
    public constructor(public readonly Label: string, public readonly Id: string)
    {
    }
}

// ComboBox item for the environment type; Label is what the collapsed selection renders.
export class TypeOption
{
    public constructor(public readonly Label: string, public readonly Id: string)
    {
    }
}

// Create form: name, template dropdown (from ListTemplates), optional host port.
export class CreateEnvironmentView extends PortalViewBase
{
    public static readonly CreateLabel = 'Create'
    public static readonly NamePlaceholder = 'Environment name'
    public static readonly PortPlaceholder = 'Host port (optional)'
    public static readonly TemplatePlaceholder = 'Template'
    public static readonly TypePlaceholder = 'Type'
    public static readonly DevelopmentLabel = 'Development'
    public static readonly DevelopmentId = 'development'
    public static readonly RuntimeLabel = 'Runtime'
    public static readonly RuntimeId = 'runtime'
    private static readonly HeadingText = 'New environment'
    private static readonly LabelPath = 'Label'
    private static readonly PortInvalid = 'Port must be a whole number'
    private static readonly NoTemplate = 'Choose a template'
    private static readonly NoType = 'Choose a type'

    private readonly nameBox = new TextBox()
    private readonly portBox = new TextBox()
    private readonly templateBox = new ComboBox()
    private readonly typeBox = new ComboBox()

    public constructor(private readonly client: ControlPlaneClient, private readonly nav: IPortalNavigator)
    {
        super()
        const heading = new TextBlock()
        heading.Text = CreateEnvironmentView.HeadingText
        this.AddChild(heading)

        this.nameBox.Placeholder = CreateEnvironmentView.NamePlaceholder
        this.AddChild(this.nameBox)

        this.templateBox.Placeholder = CreateEnvironmentView.TemplatePlaceholder
        this.templateBox.DisplayMemberPath = CreateEnvironmentView.LabelPath
        this.AddChild(this.templateBox)

        this.typeBox.Placeholder = CreateEnvironmentView.TypePlaceholder
        this.typeBox.DisplayMemberPath = CreateEnvironmentView.LabelPath
        this.typeBox.ItemsSource = [
            new TypeOption(CreateEnvironmentView.DevelopmentLabel, CreateEnvironmentView.DevelopmentId),
            new TypeOption(CreateEnvironmentView.RuntimeLabel, CreateEnvironmentView.RuntimeId),
        ]
        this.typeBox.SelectedIndex = 0
        this.AddChild(this.typeBox)

        this.portBox.Placeholder = CreateEnvironmentView.PortPlaceholder
        this.AddChild(this.portBox)

        this.AddChild(this.MakeButton(CreateEnvironmentView.CreateLabel, () => { void this.Submit() }))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowList() }))
        this.AddChild(this.message)
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            const templates = await this.client.ListTemplates()
            this.templateBox.ItemsSource = templates.map(t => new TemplateOption(t.title, t.id))
            if (templates.length > 0 && this.templateBox.SelectedItem === undefined)
            {
                this.templateBox.SelectedIndex = 0
            }
        }
        catch (e)
        {
            this.ShowError(e)
        }
    }

    private async Submit(): Promise<void>
    {
        const selected = this.templateBox.SelectedItem as TemplateOption | undefined
        if (selected === undefined)
        {
            this.message.Text = PortalViewBase.ErrorPrefix + CreateEnvironmentView.NoTemplate
            return
        }
        const selectedType = this.typeBox.SelectedItem as TypeOption | undefined
        if (selectedType === undefined)
        {
            this.message.Text = PortalViewBase.ErrorPrefix + CreateEnvironmentView.NoType
            return
        }
        let port: number | undefined
        const portText = this.portBox.Text.trim()
        if (portText.length > 0)
        {
            port = Number(portText)
            if (!Number.isInteger(port))
            {
                this.message.Text = PortalViewBase.ErrorPrefix + CreateEnvironmentView.PortInvalid
                return
            }
        }
        try
        {
            await this.client.CreateEnvironment(this.nameBox.Text.trim(), selected.Id, selectedType.Id, port)
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        this.nav.ShowList()
    }
}
