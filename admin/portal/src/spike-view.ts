import { StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'

// Spike view: a title, a "Ping" button, and a result line. Clicking the
// button fetches /api/ping and renders the returned JSON text.
export class SpikeView extends StackPanel
{
    public static readonly TitleText = 'Pragmatic Admin'
    public static readonly PingLabel = 'Ping'
    private static readonly PingUrl = '/api/ping'
    private static readonly EmptyText = ''
    private static readonly ErrorPrefix = 'error: '

    private readonly result: TextBlock

    public constructor()
    {
        super()
        const title = new TextBlock()
        title.Text = SpikeView.TitleText
        this.AddChild(title)

        const label = new TextBlock()
        label.Text = SpikeView.PingLabel
        const button = new Button()
        button.Content = label
        button.AddClickHandler(() => { void this.Ping() })
        this.AddChild(button)

        this.result = new TextBlock()
        this.result.Text = SpikeView.EmptyText
        this.AddChild(this.result)
    }

    public async Ping(): Promise<void>
    {
        try
        {
            const response = await fetch(SpikeView.PingUrl)
            this.result.Text = JSON.stringify(await response.json())
        }
        catch (e)
        {
            this.result.Text = SpikeView.ErrorPrefix + String(e)
        }
    }
}
