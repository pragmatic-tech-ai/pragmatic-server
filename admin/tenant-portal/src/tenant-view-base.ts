import { StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { KeyActivatedButton } from './kit/key-activated-button.js'
import { TenantApiError } from './tenant-api-client.js'
import type { ITenantNavigator, ITenantView } from './tenant-types.js'

// Shared base for tenant-portal screens: a button factory, an inline
// error/status line, and a run-then-refresh helper.
export abstract class TenantViewBase extends StackPanel implements ITenantView
{
    protected static readonly ErrorPrefix = 'error: '
    protected static readonly NoMessage = ''

    protected readonly message = new TextBlock()
    private sessionNav: ITenantNavigator | undefined

    public abstract Refresh(): Promise<void> | void

    public static MakeButton(label: string, onClick: () => void): Button
    {
        const text = new TextBlock()
        text.Text = label
        const button = new KeyActivatedButton(onClick)
        button.Content = text
        return button
    }

    protected MakeButton(label: string, onClick: () => void): Button
    {
        return TenantViewBase.MakeButton(label, onClick)
    }

    // The shell attaches itself so a 401 from any action can drop to login.
    public AttachNavigator(nav: ITenantNavigator): void
    {
        this.sessionNav = nav
    }

    protected get Navigator(): ITenantNavigator | undefined
    {
        return this.sessionNav
    }

    protected ShowError(e: unknown): void
    {
        if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus && this.sessionNav !== undefined)
        {
            this.sessionNav.ShowLogin()
            return
        }
        this.message.Text = TenantViewBase.ErrorPrefix + (e as Error).message
    }

    // Runs a mutating action, surfaces any error, and refreshes afterwards.
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
