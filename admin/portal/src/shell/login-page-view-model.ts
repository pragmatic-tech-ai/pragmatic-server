import { Key, RelayCommand, type KeyEventArgs } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { ControlPlaneClient } from '../api-client.js'
import type { IPageReloader } from './page-reloader.js'

// The operator sign-in form. A successful login reloads the page, which boots
// into the shell with the new session cookie; a failed one shows why and
// clears the password so it is not kept around. Enter in either box submits:
// the form's KeyDown trigger (login.mu) runs SubmitKeyCommand with the key args.
export class LoginPageViewModel extends Observable
{
    private static readonly EmailProperty = 'Email'
    private static readonly PasswordProperty = 'Password'
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly IsBusyProperty = 'IsBusy'
    private static readonly LoginText = 'Log in'

    private email = ''
    private password = ''
    private errorText = ''
    private isBusy = false
    private readonly loginCommand: RelayCommand
    private readonly submitKeyCommand: RelayCommand

    public constructor(private readonly client: ControlPlaneClient, private readonly reloader: IPageReloader)
    {
        super()
        this.loginCommand = new RelayCommand(() => { void this.Login() }, () => this.CanLogin, { Text: LoginPageViewModel.LoginText })
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
        this.RaisePropertyChanged(LoginPageViewModel.EmailProperty, old, next)
        this.loginCommand.RaiseCanExecuteChanged()
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
        this.RaisePropertyChanged(LoginPageViewModel.PasswordProperty, old, next)
        this.loginCommand.RaiseCanExecuteChanged()
    }

    // Why the last login failed; '' when none.
    public get ErrorText(): string
    {
        return this.errorText
    }

    public get IsBusy(): boolean
    {
        return this.isBusy
    }

    public get LoginCommand(): RelayCommand
    {
        return this.loginCommand
    }

    // Receives the form's KeyDown args: Return logs in (when LoginCommand
    // could), any other key is left alone.
    public get SubmitKeyCommand(): RelayCommand
    {
        return this.submitKeyCommand
    }

    // Shows why the page could not proceed, e.g. the session probe failed.
    public ShowError(text: string): void
    {
        this.SetErrorText(text)
    }

    // Signs in with the entered credentials. Busy stays set on success: the
    // page is about to reload, so the form must not submit twice.
    public async Login(): Promise<void>
    {
        if (!this.CanLogin)
        {
            return
        }
        this.SetErrorText('')
        this.SetBusy(true)
        try
        {
            await this.client.Login(this.email.trim(), this.password)
        }
        catch (e)
        {
            this.Password = ''
            this.SetErrorText(e instanceof Error ? e.message : String(e))
            this.SetBusy(false)
            return
        }
        this.reloader.Reload()
    }

    private OnKey(args: unknown): void
    {
        const key = args as Partial<KeyEventArgs> | undefined
        if (key === undefined || key.Handled === true || key.Key !== Key.Return || !this.CanLogin)
        {
            return
        }
        key.Handled = true
        void this.Login()
    }

    private get CanLogin(): boolean
    {
        return !this.isBusy && this.email.trim() !== '' && this.password !== ''
    }

    private SetErrorText(next: string): void
    {
        const old = this.errorText
        if (old === next)
        {
            return
        }
        this.errorText = next
        this.RaisePropertyChanged(LoginPageViewModel.ErrorTextProperty, old, next)
    }

    private SetBusy(next: boolean): void
    {
        const old = this.isBusy
        if (old === next)
        {
            return
        }
        this.isBusy = next
        this.RaisePropertyChanged(LoginPageViewModel.IsBusyProperty, old, next)
        this.loginCommand.RaiseCanExecuteChanged()
    }
}
