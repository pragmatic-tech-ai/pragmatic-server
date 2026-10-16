import { StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { ApiError } from './api-client.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'

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
    private static readonly UnauthorizedStatus = 401

    protected readonly message = new TextBlock()
    private sessionNav: IPortalNavigator | undefined

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

    // The shell attaches itself so a 401 from any action can drop to the login view.
    public AttachNavigator(nav: IPortalNavigator): void
    {
        this.sessionNav = nav
    }

    protected ShowError(e: unknown): void
    {
        if (e instanceof ApiError && e.Status === PortalViewBase.UnauthorizedStatus && this.sessionNav !== undefined)
        {
            this.sessionNav.ShowLogin()
            return
        }
        this.ShowMessage(e)
    }

    // Always shows the error inline (used by the login view, where 401 means bad credentials).
    protected ShowMessage(e: unknown): void
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
