import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantApiError } from '../tenant-api-client.js'
import type { AdminCapability } from './admin-capability.js'
import { ConfirmDialogViewModel, type IConfirmRequest } from './confirm-dialog-view-model.js'
import { NameConfirmDialogViewModel } from './name-confirm-dialog-view-model.js'
import type { TenantDialogViewModel } from './tenant-dialog-view-model.js'
import type { TenantSessionService } from './tenant-session-service.js'

// The states every screen presents. Denied is the server refusing the read
// (403); a refused command instead shows as a disabled command with its reason.
export enum PageState
{
    Loading,
    Empty,
    Populated,
    Error,
    Denied,
}

// An irreversible action confirmed by typing the target's name.
export interface INameConfirmRequest
{
    readonly Capability: AdminCapability
    readonly Expected: string
    readonly Title: string
    readonly Message: string
    // What happens, listed under the message.
    readonly Consequences?: readonly string[]
    // Runs inside the dialog once the name matches; a refusal shows there.
    readonly Action: () => Promise<void>
    // Runs after the dialog closes confirmed (e.g. back to the list).
    readonly OnConfirmed: () => Promise<void>
    // The confirm button's label; Delete when omitted.
    readonly ConfirmLabel?: string
}

// Base for every page view-model a section presents. Refresh() runs LoadCore()
// through the shared state machine: Loading -> Populated | Empty, or Error with
// its message, or Denied on a 403. A 401 anywhere expires the session (the page
// reloads to sign-in). Commands run through Guard(), which reports failures in
// CommandErrorText and leaves the page as it was.
export abstract class TenantPageViewModel extends Observable
{
    private static readonly StateProperty = 'State'
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly CommandErrorTextProperty = 'CommandErrorText'
    private static readonly IsLoadingProperty = 'IsLoading'
    private static readonly IsEmptyProperty = 'IsEmpty'
    private static readonly IsPopulatedProperty = 'IsPopulated'
    private static readonly IsErrorProperty = 'IsError'
    private static readonly IsDeniedProperty = 'IsDenied'
    private static readonly NoDialogsMessage = 'Dialogs are not available yet. Try again once the page has finished loading.'

    protected readonly Session: TenantSessionService
    private state = PageState.Loading
    private errorText = ''
    private commandErrorText = ''
    private loadGeneration = 0
    private mutating = false
    private readonly mutatingCommands: RelayCommand[] = []

    public constructor(session: TenantSessionService)
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

    // Why the last guarded command failed; '' when none.
    public get CommandErrorText(): string
    {
        return this.commandErrorText
    }

    // Whether the operator holds this page's primary permission (true for a
    // page without one).
    public get CanMutate(): boolean
    {
        const capability = this.PageCapability
        return capability === undefined || this.Session.Can(capability)
    }

    // Why this page's primary commands are disabled; '' when they are not.
    public get DeniedReason(): string
    {
        const capability = this.PageCapability
        return capability === undefined ? '' : this.Session.DeniedReason(capability)
    }

    // Who to ask for access, for the Denied state's text.
    public get OwnerContact(): string
    {
        return this.Session.OwnerContact
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

    public get IsDenied(): boolean
    {
        return this.state === PageState.Denied
    }

    // Loads the page. When a newer Refresh() starts before this one settles,
    // this one's result or error is discarded. A Populated page reloads
    // quietly: it stays Populated (its content showing) until the load lands,
    // and only then switches, to Empty, Error or Denied when the result says so.
    public async Refresh(): Promise<void>
    {
        const generation = ++this.loadGeneration
        this.SetErrorText('')
        if (this.state !== PageState.Populated)
        {
            this.SetState(PageState.Loading)
        }
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
            this.SetErrorText(TenantPageViewModel.MessageOf(e))
            this.SetState(TenantPageViewModel.IsForbidden(e) ? PageState.Denied : PageState.Error)
        }
    }

    // The permission this page's primary commands need; none by default.
    protected get PageCapability(): AdminCapability | undefined
    {
        return undefined
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
            this.SetCommandErrorText(TenantPageViewModel.MessageOf(e))
        }
    }

    // A mutating command needing `capability`: disabled, and a no-op when
    // executed anyway, while the operator lacks it, `enabled` says no, or any
    // of this page's mutating commands is still running. Its body runs through
    // Guard. The in-flight lock outlives a dismissed dialog, so a second action
    // can never overtake (and drop) the first's one-time result.
    protected MutatingCommand(capability: AdminCapability, run: (parameter: unknown) => Promise<void>, enabled?: (parameter: unknown) => boolean): RelayCommand
    {
        const can = (parameter?: unknown): boolean => this.Session.Can(capability) && !this.mutating && (enabled === undefined || enabled(parameter))
        const command = new RelayCommand((parameter) =>
        {
            if (can(parameter))
            {
                void this.RunMutating(() => run(parameter))
            }
        }, can)
        this.mutatingCommands.push(command)
        return command
    }

    // Re-evaluates every mutating command (a field `enabled` reads changed).
    protected RaiseMutatingCommandsChanged(): void
    {
        for (const command of this.mutatingCommands)
        {
            command.RaiseCanExecuteChanged()
        }
    }

    // Opens a create dialog (loading its choices first); when it produces a
    // result, hands it to onCreated. Run it inside a command's Guard: a
    // missing DialogService or a failure is reported in CommandErrorText.
    protected async OpenCreate<T>(
        dialogs: DialogService | undefined,
        create: (dialogs: DialogService) => TenantDialogViewModel<T>,
        title: string,
        onCreated: (result: T) => Promise<void>,
    ): Promise<void>
    {
        const dialog = create(TenantPageViewModel.RequireDialogs(dialogs))
        await dialog.Load()
        const result = await dialog.Open(title)
        if (result !== undefined)
        {
            await onCreated(result)
        }
    }

    // Asks for the target's name before an irreversible action; runs
    // OnConfirmed once the dialog closes confirmed. Run it inside a Guard.
    protected async ConfirmByName(dialogs: DialogService | undefined, request: INameConfirmRequest): Promise<void>
    {
        const confirm = new NameConfirmDialogViewModel(this.Session, TenantPageViewModel.RequireDialogs(dialogs), request)
        if (await confirm.Open(request.Title) === NameConfirmDialogViewModel.Confirmed)
        {
            await request.OnConfirmed()
        }
    }

    // Asks a plain yes / no (with consequences and an optional warning)
    // before an action; runs OnConfirmed once confirmed. Run it inside a Guard.
    protected async Confirm(dialogs: DialogService | undefined, request: IConfirmRequest): Promise<void>
    {
        const confirm = new ConfirmDialogViewModel(this.Session, TenantPageViewModel.RequireDialogs(dialogs), request)
        if (await confirm.Open(request.Title) === ConfirmDialogViewModel.Confirmed)
        {
            await request.OnConfirmed()
        }
    }

    private async RunMutating(run: () => Promise<void>): Promise<void>
    {
        this.SetMutating(true)
        try
        {
            await this.Guard(run)
        }
        finally
        {
            this.SetMutating(false)
        }
    }

    private SetMutating(next: boolean): void
    {
        if (this.mutating === next)
        {
            return
        }
        this.mutating = next
        this.RaiseMutatingCommandsChanged()
    }

    private static RequireDialogs(dialogs: DialogService | undefined): DialogService
    {
        if (dialogs === undefined)
        {
            throw new Error(TenantPageViewModel.NoDialogsMessage)
        }
        return dialogs
    }

    private TryExpire(e: unknown): boolean
    {
        if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus)
        {
            this.Session.Expire()
            return true
        }
        return false
    }

    private static IsForbidden(e: unknown): boolean
    {
        return e instanceof TenantApiError && e.Status === TenantApiError.ForbiddenStatus
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
        const was = [this.IsLoading, this.IsEmpty, this.IsPopulated, this.IsError, this.IsDenied] as const
        this.state = next
        const P = TenantPageViewModel
        this.RaisePropertyChanged(P.StateProperty, old, next)
        this.RaisePropertyChanged(P.IsLoadingProperty, was[0], this.IsLoading)
        this.RaisePropertyChanged(P.IsEmptyProperty, was[1], this.IsEmpty)
        this.RaisePropertyChanged(P.IsPopulatedProperty, was[2], this.IsPopulated)
        this.RaisePropertyChanged(P.IsErrorProperty, was[3], this.IsError)
        this.RaisePropertyChanged(P.IsDeniedProperty, was[4], this.IsDenied)
    }

    private SetCommandErrorText(next: string): void
    {
        const old = this.commandErrorText
        if (old === next)
        {
            return
        }
        this.commandErrorText = next
        this.RaisePropertyChanged(TenantPageViewModel.CommandErrorTextProperty, old, next)
    }

    private SetErrorText(next: string): void
    {
        const old = this.errorText
        if (old === next)
        {
            return
        }
        this.errorText = next
        this.RaisePropertyChanged(TenantPageViewModel.ErrorTextProperty, old, next)
    }
}
