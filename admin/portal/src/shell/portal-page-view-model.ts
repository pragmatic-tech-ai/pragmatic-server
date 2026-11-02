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
export abstract class PortalPageViewModel extends Observable
{
    private static readonly StateProperty = 'State'
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly IsLoadingProperty = 'IsLoading'
    private static readonly IsEmptyProperty = 'IsEmpty'
    private static readonly IsPopulatedProperty = 'IsPopulated'
    private static readonly IsErrorProperty = 'IsError'

    protected readonly Session: PortalSessionService
    private state = PageState.Loading
    private errorText = ''

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

    public async Refresh(): Promise<void>
    {
        this.SetErrorText('')
        this.SetState(PageState.Loading)
        try
        {
            const hasContent = await this.LoadCore()
            this.SetState(hasContent ? PageState.Populated : PageState.Empty)
        }
        catch (e)
        {
            this.HandleFailure(e)
        }
    }

    // Loads the page's data; true when there is content to show.
    protected abstract LoadCore(): Promise<boolean>

    // Runs a command body with the same 401 / error handling as Refresh().
    protected async Guard(action: () => Promise<void>): Promise<void>
    {
        try
        {
            await action()
        }
        catch (e)
        {
            this.HandleFailure(e)
        }
    }

    private HandleFailure(e: unknown): void
    {
        if (e instanceof ApiError && e.Status === ApiError.UnauthorizedStatus)
        {
            this.Session.Expire()
            return
        }
        this.SetErrorText(e instanceof Error ? e.message : String(e))
        this.SetState(PageState.Error)
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
