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

// Create form: name, template dropdown (from ListTemplates), optional host port.
export class CreateEnvironmentView extends PortalViewBase
{
    public static readonly CreateLabel = 'Create'
    public static readonly NamePlaceholder = 'Environment name'
    public static readonly PortPlaceholder = 'Host port (optional)'
    public static readonly TemplatePlaceholder = 'Template'
    private static readonly HeadingText = 'New environment'
    private static readonly LabelPath = 'Label'
    private static readonly PortInvalid = 'Port must be a whole number'
    private static readonly NoTemplate = 'Choose a template'

    private readonly nameBox = new TextBox()
    private readonly portBox = new TextBox()
    private readonly templateBox = new ComboBox()

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
            await this.client.CreateEnvironment(this.nameBox.Text.trim(), selected.Id, port)
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        this.nav.ShowList()
    }
}
