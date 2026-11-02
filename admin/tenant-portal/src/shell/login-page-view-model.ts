import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { IPageReloader } from './page-reloader.js'

// Starts the tenant sign-in: the identity provider owns the credentials, so
// signing in is a redirect (the client's BeginLogin), never a password form.
export interface ISignInStarter
{
    BeginLogin(): void
}

// The sign-in page. Booted only when the session probe failed for a reason
// other than "not signed in" (no session redirects straight to the identity
// provider): it says why, offers Sign in, and Try again (reload).
export class LoginPageViewModel extends Observable
{
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly IsBusyProperty = 'IsBusy'
    private static readonly SignInText = 'Sign in'
    private static readonly RetryText = 'Try again'

    private errorText = ''
    private isBusy = false
    private readonly signInCommand: RelayCommand
    private readonly retryCommand: RelayCommand

    public constructor(private readonly starter: ISignInStarter, private readonly reloader: IPageReloader)
    {
        super()
        this.signInCommand = new RelayCommand(() => this.SignIn(), () => !this.isBusy, { Text: LoginPageViewModel.SignInText })
        this.retryCommand = new RelayCommand(() => this.Retry(), () => !this.isBusy, { Text: LoginPageViewModel.RetryText })
    }

    // Why the shell could not start; '' when none.
    public get ErrorText(): string
    {
        return this.errorText
    }

    public get IsBusy(): boolean
    {
        return this.isBusy
    }

    public get SignInCommand(): RelayCommand
    {
        return this.signInCommand
    }

    public get RetryCommand(): RelayCommand
    {
        return this.retryCommand
    }

    public ShowError(text: string): void
    {
        const old = this.errorText
        if (old === text)
        {
            return
        }
        this.errorText = text
        this.RaisePropertyChanged(LoginPageViewModel.ErrorTextProperty, old, text)
    }

    // Busy stays set: the page is navigating away, so it must not start twice.
    private SignIn(): void
    {
        if (this.isBusy)
        {
            return
        }
        this.SetBusy(true)
        this.starter.BeginLogin()
    }

    private Retry(): void
    {
        if (this.isBusy)
        {
            return
        }
        this.SetBusy(true)
        this.reloader.Reload()
    }

    private SetBusy(next: boolean): void
    {
        const old = this.isBusy
        this.isBusy = next
        this.RaisePropertyChanged(LoginPageViewModel.IsBusyProperty, old, next)
        this.signInCommand.RaiseCanExecuteChanged()
        this.retryCommand.RaiseCanExecuteChanged()
    }
}
