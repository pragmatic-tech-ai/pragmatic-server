import { ConfirmAsk } from '@pragmatic-tech-ai/todl-runtime'
import type { Ask, IPromptService, FileFilter, Choice } from '@pragmatic-tech-ai/todl-runtime'

/**
 * Non-interactive prompt service for development environments: every confirmation is auto-accepted so the solution
 * manager's "discard unsaved changes?" gate (canReplace) never blocks or refuses a server-side solution switch
 * (`solution/create`). Nothing a user typed is at stake server-side: the active solution is only ever a source mirror
 * the client re-seeds over `storage/*`. Every other ask is delegated to the wrapped (headless) service unchanged.
 */
export class AutoConfirmPromptService implements IPromptService
{
    public constructor(private readonly inner: IPromptService)
    {
    }

    public Ask<R>(request: Ask<R>): Promise<R>
    {
        if (request instanceof ConfirmAsk)
        {
            return Promise.resolve(true as R)
        }
        return this.inner.Ask(request)
    }

    public Confirm(_message: string, _confirmLabel?: string): Promise<boolean>
    {
        return Promise.resolve(true)
    }

    public PickFolder(title: string): Promise<string | undefined>
    {
        return this.inner.PickFolder(title)
    }

    public PickFile(title: string, filters?: readonly FileFilter[]): Promise<string | undefined>
    {
        return this.inner.PickFile(title, filters)
    }

    public PromptText(label: string, initial?: string): Promise<string | undefined>
    {
        return this.inner.PromptText(label, initial)
    }

    public Choose<T>(title: string, options: readonly Choice<T>[]): Promise<T | undefined>
    {
        return this.inner.Choose(title, options)
    }
}
