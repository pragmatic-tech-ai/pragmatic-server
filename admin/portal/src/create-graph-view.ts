import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import type { ControlPlaneClient } from './api-client.js'
import type { IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// Create form for a graph: name and description.
export class CreateGraphView extends PortalViewBase
{
    public static readonly CreateLabel = 'Create'
    public static readonly NamePlaceholder = 'Graph name'
    public static readonly DescriptionPlaceholder = 'Description'
    private static readonly HeadingText = 'New graph'
    private static readonly FieldsRequired = 'Name and description are required'

    private readonly nameBox = new TextBox()
    private readonly descriptionBox = new TextBox()

    public constructor(private readonly client: ControlPlaneClient, private readonly nav: IPortalNavigator, private readonly envName: string)
    {
        super()
        const heading = new TextBlock()
        heading.Text = CreateGraphView.HeadingText
        this.AddChild(heading)
        this.nameBox.Placeholder = CreateGraphView.NamePlaceholder
        this.AddChild(this.nameBox)
        this.descriptionBox.Placeholder = CreateGraphView.DescriptionPlaceholder
        this.AddChild(this.descriptionBox)
        this.AddChild(this.MakeButton(CreateGraphView.CreateLabel, () => { void this.Submit() }))
        this.AddChild(this.MakeButton(PortalViewBase.BackLabel, () => { this.nav.ShowGraphs(this.envName) }))
        this.AddChild(this.message)
    }

    // Nothing to pre-load.
    public Refresh(): Promise<void>
    {
        return Promise.resolve()
    }

    private async Submit(): Promise<void>
    {
        const name = this.nameBox.Text.trim()
        const description = this.descriptionBox.Text.trim()
        if (name.length === 0 || description.length === 0)
        {
            this.message.Text = PortalViewBase.ErrorPrefix + CreateGraphView.FieldsRequired
            return
        }
        try
        {
            await this.client.CreateGraph(this.envName, name, description)
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        this.nav.ShowGraphs(this.envName)
    }
}
