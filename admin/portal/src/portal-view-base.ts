import { StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import type { IPortalView } from './portal-types.js'

// Shared base for portal screens: common button labels, a button factory,
// an error/status message line, and a run-then-refresh helper.
export abstract class PortalViewBase extends StackPanel implements IPortalView
{
    public static readonly StartLabel = 'Start'
    public static readonly StopLabel = 'Stop'
    public static readonly DeleteLabel = 'Delete'
    public static readonly ConfirmDeleteLabel = 'Confirm delete'
    public static readonly CancelLabel = 'Cancel'
    public static readonly BackLabel = 'Back'
    protected static readonly ErrorPrefix = 'error: '
    protected static readonly NoMessage = ''

    protected readonly message = new TextBlock()

    public abstract Refresh(): Promise<void>

    protected MakeButton(label: string, onClick: () => void): Button
    {
        const text = new TextBlock()
        text.Text = label
        const button = new Button()
        button.Content = text
        button.AddClickHandler(onClick)
        return button
    }

    protected ShowError(e: unknown): void
    {
        this.message.Text = PortalViewBase.ErrorPrefix + (e as Error).message
    }

    // Runs a mutating action, surfaces any error, and refreshes on success.
    protected async Run(action: () => Promise<unknown>): Promise<void>
    {
        try
        {
            await action()
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        await this.Refresh()
    }
}
