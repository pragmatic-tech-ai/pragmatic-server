import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../api-client.js'
import type { PortalSessionService } from './portal-session-service.js'

// The four states every screen presents. Denied is covered by disabled commands.
export enum PageState
{
    Loading,
    Empty,
    Populated,
    Error,
}

// Base for every page view-model a section presents. Refresh() runs LoadCore()
// through the shared state machine: Loading -> Populated | Empty, or Error with
// its message. A 401 anywhere expires the session (the page reloads to login).
// Commands run through Guard(), which reports failures in CommandErrorText.
export abstract class PortalPageViewModel extends Observable
{
    private static readonly StateProperty = 'State'
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly CommandErrorTextProperty = 'CommandErrorText'
    private static readonly IsLoadingProperty = 'IsLoading'
    private static readonly IsEmptyProperty = 'IsEmpty'
    private static readonly IsPopulatedProperty = 'IsPopulated'
    private static readonly IsErrorProperty = 'IsError'

    protected readonly Session: PortalSessionService
    private state = PageState.Loading
    private errorText = ''
    private commandErrorText = ''
    private loadGeneration = 0

    public constructor(session: PortalSessionService)
    {
        super()
        this.Session = session
    }

    public get State(): PageState
    {
        return this.state
    }

    public get ErrorText(): string
    {
        return this.errorText
    }

    // Why the last guarded command failed; '' when none. A failed command
    // leaves the page's State and content as they were.
    public get CommandErrorText(): string
    {
        return this.commandErrorText
    }

    // Per-state flags for the template's Visibility bindings.
    public get IsLoading(): boolean
    {
        return this.state === PageState.Loading
    }

    public get IsEmpty(): boolean
    {
        return this.state === PageState.Empty
    }

    public get IsPopulated(): boolean
    {
        return this.state === PageState.Populated
    }

    public get IsError(): boolean
    {
        return this.state === PageState.Error
    }

    // Loads the page. When a newer Refresh() starts before this one settles,
    // this one's result or error is discarded.
    public async Refresh(): Promise<void>
    {
        const generation = ++this.loadGeneration
        this.SetErrorText('')
        this.SetState(PageState.Loading)
        try
        {
            const hasContent = await this.LoadCore()
            if (generation !== this.loadGeneration)
            {
                return
            }
            this.SetState(hasContent ? PageState.Populated : PageState.Empty)
        }
        catch (e)
        {
            if (generation !== this.loadGeneration)
            {
                return
            }
            if (this.TryExpire(e))
            {
                return
            }
            this.SetErrorText(PortalPageViewModel.MessageOf(e))
            this.SetState(PageState.Error)
        }
    }

    // The generation of the latest Refresh(). A LoadCore that applies data
    // after an await captures it first and skips applying when it changed.
    protected get LoadGeneration(): number
    {
        return this.loadGeneration
    }

    // Loads the page's data; true when there is content to show.
    protected abstract LoadCore(): Promise<boolean>

    // Runs a command body: a 401 expires the session; any other failure sets
    // CommandErrorText and leaves State as it was.
    protected async Guard(action: () => Promise<void>): Promise<void>
    {
        this.SetCommandErrorText('')
        try
        {
            await action()
        }
        catch (e)
        {
            if (this.TryExpire(e))
            {
                return
            }
            this.SetCommandErrorText(PortalPageViewModel.MessageOf(e))
        }
    }

    private TryExpire(e: unknown): boolean
    {
        if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
        {
            this.Session.Expire()
            return true
        }
        return false
    }

    private static MessageOf(e: unknown): string
    {
        return e instanceof Error ? e.message : String(e)
    }

    private SetState(next: PageState): void
    {
        const old = this.state
        if (old === next)
        {
            return
        }
        const wasLoading = this.IsLoading
        const wasEmpty = this.IsEmpty
        const wasPopulated = this.IsPopulated
        const wasError = this.IsError
        this.state = next
        this.RaisePropertyChanged(PortalPageViewModel.StateProperty, old, next)
        this.RaisePropertyChanged(PortalPageViewModel.IsLoadingProperty, wasLoading, this.IsLoading)
        this.RaisePropertyChanged(PortalPageViewModel.IsEmptyProperty, wasEmpty, this.IsEmpty)
        this.RaisePropertyChanged(PortalPageViewModel.IsPopulatedProperty, wasPopulated, this.IsPopulated)
        this.RaisePropertyChanged(PortalPageViewModel.IsErrorProperty, wasError, this.IsError)
    }

    private SetCommandErrorText(next: string): void
    {
        const old = this.commandErrorText
        if (old === next)
        {
            return
        }
        this.commandErrorText = next
        this.RaisePropertyChanged(PortalPageViewModel.CommandErrorTextProperty, old, next)
    }

    private SetErrorText(next: string): void
    {
        const old = this.errorText
        if (old === next)
        {
            return
        }
        this.errorText = next
        this.RaisePropertyChanged(PortalPageViewModel.ErrorTextProperty, old, next)
    }
}
