import { Key, RelayCommand, type KeyEventArgs } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { IFormPoster } from './form-poster.js'

// The IdP sign-in form. Signing in hands the email and password to a native
// form POST back to the authorize endpoint (the same fields and URL the IdP
// always accepted): the browser follows the IdP's redirect to the application,
// or the IdP serves this page again flagged as failed. The password is never
// kept beyond that post and never logged. Enter in either box submits: the
// form's KeyDown trigger (login.mu) runs SubmitKeyCommand with the key args.
export class IdpLoginViewModel extends Observable
{
    public static readonly EmailField = 'email'
    public static readonly PasswordField = 'password'
    private static readonly FailedMessage = 'Invalid email or password.'
    private static readonly NoText = ''
    private static readonly SignInText = 'Sign in'
    private static readonly EmailProperty = 'Email'
    private static readonly PasswordProperty = 'Password'
    private static readonly IsBusyProperty = 'IsBusy'

    private email = IdpLoginViewModel.NoText
    private password = IdpLoginViewModel.NoText
    private isBusy = false
    private readonly errorText: string
    private readonly signInCommand: RelayCommand
    private readonly submitKeyCommand: RelayCommand

    // `failed`: the IdP served this page after a rejected sign-in.
    public constructor(private readonly poster: IFormPoster, failed: boolean)
    {
        super()
        this.errorText = failed ? IdpLoginViewModel.FailedMessage : IdpLoginViewModel.NoText
        this.signInCommand = new RelayCommand(() => this.SignIn(), () => this.CanSignIn, { Text: IdpLoginViewModel.SignInText })
        this.submitKeyCommand = new RelayCommand((args) => this.OnKey(args))
    }

    public get Email(): string
    {
        return this.email
    }

    public set Email(next: string)
    {
        const old = this.email
        if (old === next)
        {
            return
        }
        this.email = next
        this.RaisePropertyChanged(IdpLoginViewModel.EmailProperty, old, next)
        this.signInCommand.RaiseCanExecuteChanged()
    }

    public get Password(): string
    {
        return this.password
    }

    public set Password(next: string)
    {
        const old = this.password
        if (old === next)
        {
            return
        }
        this.password = next
        this.RaisePropertyChanged(IdpLoginViewModel.PasswordProperty, old, next)
        this.signInCommand.RaiseCanExecuteChanged()
    }

    // Why the last sign-in failed; '' when it did not.
    public get ErrorText(): string
    {
        return this.errorText
    }

    // True once the form is posted: the page is navigating away.
    public get IsBusy(): boolean
    {
        return this.isBusy
    }

    public get SignInCommand(): RelayCommand
    {
        return this.signInCommand
    }

    // Receives the form's KeyDown args: Return signs in (when SignInCommand
    // could), any other key is left alone.
    public get SubmitKeyCommand(): RelayCommand
    {
        return this.submitKeyCommand
    }

    // Posts the credentials once; the browser navigates away with the response.
    public SignIn(): void
    {
        if (!this.CanSignIn)
        {
            return
        }
        this.SetBusy(true)
        const fields = new Map<string, string>([
            [IdpLoginViewModel.EmailField, this.email.trim()],
            [IdpLoginViewModel.PasswordField, this.password],
        ])
        this.Password = IdpLoginViewModel.NoText
        this.poster.Post(fields)
    }

    // The page came back without a navigation (the browser's back/forward
    // cache restored it after the post, or the post was stopped): the form is
    // usable again, still without the password.
    public Reset(): void
    {
        this.Password = IdpLoginViewModel.NoText
        this.SetBusy(false)
    }

    private OnKey(args: unknown): void
    {
        const key = args as Partial<KeyEventArgs> | undefined
        if (key === undefined || key.Handled === true || key.Key !== Key.Return || !this.CanSignIn)
        {
            return
        }
        key.Handled = true
        this.SignIn()
    }

    private get CanSignIn(): boolean
    {
        return !this.isBusy && this.email.trim() !== IdpLoginViewModel.NoText && this.password !== IdpLoginViewModel.NoText
    }

    private SetBusy(next: boolean): void
    {
        const old = this.isBusy
        if (old === next)
        {
            return
        }
        this.isBusy = next
        this.RaisePropertyChanged(IdpLoginViewModel.IsBusyProperty, old, next)
        this.signInCommand.RaiseCanExecuteChanged()
    }
}
