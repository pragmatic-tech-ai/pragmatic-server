import { Key, ObservableCollection, RelayCommand, type KeyEventArgs } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import
{
    IdentityPlatformProvider,
    IdentityPlatformRestClient,
    IdentityPlatformRestError,
} from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/client'
import { FederatedRoundTrip, PendingFederatedSignIn } from './federated-round-trip.js'
import { LoginAnswer, type ILoginBackend } from './login-backend.js'
import type { LoginConfig } from './login-config.js'
import type { LoginPageLocation } from './login-page-location.js'
import { LoginSourceViewModel } from './login-source-view-model.js'
import type { IPageNavigator } from './page-navigator.js'

// Which form the page shows.
export enum LoginMode
{
    SignIn = 'SignIn',
    SignUp = 'SignUp',
    Forgot = 'Forgot',
}

// The realm sign-in page. It loads what the realm offers (GET <issuer>/login/config)
// and signs in by posting JSON to <issuer>/login:
// - local accounts: `{ request, method: 'password', email, password }`;
// - Identity Platform (email/password, sign-up, password reset, Google): the
//   browser talks to Identity Platform itself, then posts
//   `{ request, method: 'identityPlatform', idToken }`;
// - upstream sources (Google, Microsoft, OIDC, Pragmatic): a button per source
//   navigates the page to the source's broker login with the request appended.
// A 200 answer's redirect is followed with a top-level navigation; a refusal
// shows why. The password is never kept beyond its use and never logged.
// Enter in any box submits the current form (the form's KeyDown trigger in
// login.mu runs SubmitKeyCommand with the key args).
export class IdpLoginViewModel extends Observable
{
    public static readonly RequestField = 'request'
    public static readonly MethodField = 'method'
    public static readonly EmailField = 'email'
    public static readonly PasswordField = 'password'
    public static readonly IdTokenField = 'idToken'
    public static readonly PasswordMethod = 'password'
    public static readonly IdentityPlatformMethod = 'identityPlatform'

    private static readonly NoText = ''
    private static readonly SignInTitle = 'Sign in'
    private static readonly SignUpTitle = 'Create an account'
    private static readonly ForgotTitle = 'Reset your password'
    private static readonly SignInSubtitle = 'Use your organisation account.'
    private static readonly SignUpSubtitle = 'Sign up with your email address.'
    private static readonly ForgotSubtitle = 'We will email you a link to choose a new password.'
    private static readonly InvalidCredentialsMessage = 'Invalid email or password.'
    private static readonly EmailNotVerifiedMessage = 'Verify your email address first: open the link in the email we sent you, then sign in again.'
    private static readonly TooManyAttemptsMessage = 'Too many attempts. Try again later.'
    private static readonly TooManyAttemptsPrefix = 'Too many attempts. Try again in '
    private static readonly TooManyAttemptsSuffix = ' seconds.'
    private static readonly BadRequestMessage = 'This sign-in link is no longer valid. Return to the application and sign in again.'
    private static readonly UnavailableMessage = 'Sign-in is unavailable right now. Please try again.'
    private static readonly ConfigUnavailableMessage = 'The sign-in page could not load. Please reload it.'
    private static readonly NoMethodMessage = 'No sign-in method is configured for this realm.'
    private static readonly EmailExistsMessage = 'An account with this email already exists. Sign in instead.'
    private static readonly WeakPasswordMessage = 'Choose a stronger password (at least 6 characters).'
    private static readonly InvalidEmailMessage = 'Enter a valid email address.'
    private static readonly DisabledMessage = 'This account is disabled.'
    private static readonly MismatchMessage = 'The passwords do not match.'
    private static readonly GoogleFailedMessage = 'Signing in with Google did not complete. Please try again.'
    private static readonly CheckEmailMessage = 'Check your email, then sign in.'
    private static readonly VerificationNotSentMessage = 'Your account was created, but the verification email could not be sent. Sign in to send it again.'
    private static readonly ResetSentMessage = 'If an account exists for that email, we sent it a link to reset the password.'
    private static readonly VerificationResentMessage = 'We sent a new verification email. Open its link, then sign in.'
    private static readonly SignInText = 'Sign in'
    private static readonly SignUpText = 'Create account'
    private static readonly ResetText = 'Send reset link'
    private static readonly GoogleText = 'Continue with Google'
    private static readonly ResendText = 'Resend verification email'
    // Identity Platform's error codes the page tells apart.
    private static readonly IpInvalidCredentials = 'INVALID_LOGIN_CREDENTIALS'
    private static readonly IpEmailNotFound = 'EMAIL_NOT_FOUND'
    private static readonly IpInvalidPassword = 'INVALID_PASSWORD'
    private static readonly IpEmailExists = 'EMAIL_EXISTS'
    private static readonly IpWeakPassword = 'WEAK_PASSWORD'
    private static readonly IpInvalidEmail = 'INVALID_EMAIL'
    private static readonly IpUserDisabled = 'USER_DISABLED'
    private static readonly IpTooManyAttempts = 'TOO_MANY_ATTEMPTS_TRY_LATER'
    private static readonly IpCredentialCodes: readonly string[] = [
        IdpLoginViewModel.IpInvalidCredentials, IdpLoginViewModel.IpEmailNotFound, IdpLoginViewModel.IpInvalidPassword,
    ]
    // The bound properties.
    private static readonly EmailProperty = 'Email'
    private static readonly PasswordProperty = 'Password'
    private static readonly ConfirmPasswordProperty = 'ConfirmPassword'
    // Everything derived from the page state, re-announced (when changed) after each state change.
    private static readonly DerivedProperties: readonly string[] = [
        'IsBusy', 'IsLoading', 'ErrorText', 'NoticeText', 'Title', 'Subtitle', 'DisplayName',
        'IsSignInMode', 'IsSignUpMode', 'IsForgotMode',
        'ShowsPasswordForm', 'ShowsCurrentPassword', 'ShowsNewPassword', 'ShowsConfirm',
        'ShowsSignInButton', 'ShowsSignUpButton', 'ShowsResetButton',
        'ShowsSources', 'ShowsGoogle', 'ShowsDivider',
        'ShowsForgotLink', 'ShowsCreateAccountLink', 'ShowsBackToSignIn', 'ShowsResend',
    ]

    private email = IdpLoginViewModel.NoText
    private password = IdpLoginViewModel.NoText
    private confirmPassword = IdpLoginViewModel.NoText
    private errorText: string
    private noticeText = IdpLoginViewModel.NoText
    private isBusy = false
    private isLoading = true
    private mode = LoginMode.SignIn
    private config: LoginConfig | undefined
    private page: LoginPageLocation
    private identityPlatform: IdentityPlatformRestClient | undefined
    // The ID token of a sign-in refused as email_not_verified (or a sign-up whose email was not sent): Resend uses it.
    private unverifiedToken: string | undefined
    private readonly announced = new Map<string, unknown>()
    private readonly sources = new ObservableCollection<LoginSourceViewModel>()
    private readonly signInCommand: RelayCommand
    private readonly signUpCommand: RelayCommand
    private readonly sendResetCommand: RelayCommand
    private readonly googleCommand: RelayCommand
    private readonly resendCommand: RelayCommand
    private readonly showSignInCommand: RelayCommand
    private readonly showSignUpCommand: RelayCommand
    private readonly showForgotCommand: RelayCommand
    private readonly submitKeyCommand: RelayCommand
    private readonly commands: readonly RelayCommand[]

    // `location`: where the page was served (the authorize URL and its request).
    // `fetchFn`: drives Identity Platform. `failed`: the page was served flagged
    // after a rejected sign-in.
    public constructor(
        private readonly backend: ILoginBackend,
        private readonly navigator: IPageNavigator,
        private readonly location: LoginPageLocation,
        private readonly roundTrip: FederatedRoundTrip,
        private readonly fetchFn: typeof fetch,
        failed: boolean = false)
    {
        super()
        const V = IdpLoginViewModel
        this.page = location
        this.errorText = failed ? V.InvalidCredentialsMessage : V.NoText
        this.signInCommand = new RelayCommand(() => void this.SignIn(), () => this.CanSignIn, { Text: V.SignInText })
        this.signUpCommand = new RelayCommand(() => void this.SignUp(), () => this.CanSignUp, { Text: V.SignUpText })
        this.sendResetCommand = new RelayCommand(() => void this.SendReset(), () => this.CanSendReset, { Text: V.ResetText })
        this.googleCommand = new RelayCommand(() => void this.SignInWithGoogle(), () => !this.isBusy && this.ShowsGoogle, { Text: V.GoogleText })
        this.resendCommand = new RelayCommand(() => void this.ResendVerification(), () => !this.isBusy && this.unverifiedToken !== undefined, { Text: V.ResendText })
        this.showSignInCommand = new RelayCommand(() => this.SwitchTo(LoginMode.SignIn), () => !this.isBusy)
        this.showSignUpCommand = new RelayCommand(() => this.SwitchTo(LoginMode.SignUp), () => !this.isBusy && this.OffersSignUp)
        this.showForgotCommand = new RelayCommand(() => this.SwitchTo(LoginMode.Forgot), () => !this.isBusy && this.UsesIdentityPlatformPassword)
        this.submitKeyCommand = new RelayCommand((args) => this.OnKey(args))
        this.commands = [
            this.signInCommand, this.signUpCommand, this.sendResetCommand, this.googleCommand, this.resendCommand,
            this.showSignInCommand, this.showSignUpCommand, this.showForgotCommand,
        ]
        this.Remember()
    }

    // ── Bound state ──────────────────────────────────────────────────

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
        this.RaiseCommands()
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
        this.RaiseCommands()
    }

    // The sign-up form's second password box.
    public get ConfirmPassword(): string
    {
        return this.confirmPassword
    }

    public set ConfirmPassword(next: string)
    {
        const old = this.confirmPassword
        if (old === next)
        {
            return
        }
        this.confirmPassword = next
        this.RaisePropertyChanged(IdpLoginViewModel.ConfirmPasswordProperty, old, next)
        this.RaiseCommands()
    }

    // Why the last action failed; '' when it did not.
    public get ErrorText(): string
    {
        return this.errorText
    }

    // What the last action did (an email sent); '' when nothing to say.
    public get NoticeText(): string
    {
        return this.noticeText
    }

    // True while the page waits on Identity Platform or the sign-in service, and once it navigates away.
    public get IsBusy(): boolean
    {
        return this.isBusy
    }

    // True until the realm's config has loaded (or failed to).
    public get IsLoading(): boolean
    {
        return this.isLoading
    }

    public get Mode(): LoginMode
    {
        return this.mode
    }

    public get Title(): string
    {
        const V = IdpLoginViewModel
        return this.mode === LoginMode.SignUp ? V.SignUpTitle : this.mode === LoginMode.Forgot ? V.ForgotTitle : V.SignInTitle
    }

    public get Subtitle(): string
    {
        const V = IdpLoginViewModel
        return this.mode === LoginMode.SignUp ? V.SignUpSubtitle : this.mode === LoginMode.Forgot ? V.ForgotSubtitle : V.SignInSubtitle
    }

    // The realm's display name; '' until the config loads.
    public get DisplayName(): string
    {
        return this.config?.DisplayName ?? IdpLoginViewModel.NoText
    }

    public get IsSignInMode(): boolean
    {
        return this.mode === LoginMode.SignIn
    }

    public get IsSignUpMode(): boolean
    {
        return this.mode === LoginMode.SignUp
    }

    public get IsForgotMode(): boolean
    {
        return this.mode === LoginMode.Forgot
    }

    // The email box (and, by mode, the password boxes): local accounts or Identity Platform email/password.
    public get ShowsPasswordForm(): boolean
    {
        return this.config !== undefined && (this.config.Local || this.UsesIdentityPlatformPassword)
    }

    public get ShowsCurrentPassword(): boolean
    {
        return this.ShowsPasswordForm && this.IsSignInMode
    }

    public get ShowsNewPassword(): boolean
    {
        return this.ShowsPasswordForm && this.IsSignUpMode
    }

    public get ShowsConfirm(): boolean
    {
        return this.ShowsNewPassword
    }

    public get ShowsSignInButton(): boolean
    {
        return this.ShowsCurrentPassword
    }

    public get ShowsSignUpButton(): boolean
    {
        return this.ShowsNewPassword
    }

    public get ShowsResetButton(): boolean
    {
        return this.ShowsPasswordForm && this.IsForgotMode
    }

    // One button per upstream source, on the sign-in form.
    public get Sources(): ObservableCollection<LoginSourceViewModel>
    {
        return this.sources
    }

    public get ShowsSources(): boolean
    {
        return this.IsSignInMode && this.sources.Count > 0
    }

    // Continue with Google (through Identity Platform), on the sign-in and sign-up forms.
    public get ShowsGoogle(): boolean
    {
        return !this.IsForgotMode && this.config?.IdentityPlatform?.Enables(IdentityPlatformProvider.Google) === true
    }

    // The "or" between the buttons and the email form.
    public get ShowsDivider(): boolean
    {
        return !this.IsForgotMode && this.ShowsPasswordForm && (this.ShowsSources || this.ShowsGoogle)
    }

    public get ShowsForgotLink(): boolean
    {
        return this.IsSignInMode && this.UsesIdentityPlatformPassword
    }

    public get ShowsCreateAccountLink(): boolean
    {
        return this.IsSignInMode && this.OffersSignUp
    }

    public get ShowsBackToSignIn(): boolean
    {
        return !this.IsSignInMode
    }

    // The Resend verification email action (after an email_not_verified refusal).
    public get ShowsResend(): boolean
    {
        return this.unverifiedToken !== undefined
    }

    // ── Commands ─────────────────────────────────────────────────────

    public get SignInCommand(): RelayCommand
    {
        return this.signInCommand
    }

    public get SignUpCommand(): RelayCommand
    {
        return this.signUpCommand
    }

    public get SendResetCommand(): RelayCommand
    {
        return this.sendResetCommand
    }

    public get GoogleCommand(): RelayCommand
    {
        return this.googleCommand
    }

    public get ResendVerificationCommand(): RelayCommand
    {
        return this.resendCommand
    }

    public get ShowSignInCommand(): RelayCommand
    {
        return this.showSignInCommand
    }

    public get ShowSignUpCommand(): RelayCommand
    {
        return this.showSignUpCommand
    }

    public get ShowForgotCommand(): RelayCommand
    {
        return this.showForgotCommand
    }

    // Receives the form's KeyDown args: Return submits the current form (when it
    // could be submitted), any other key is left alone.
    public get SubmitKeyCommand(): RelayCommand
    {
        return this.submitKeyCommand
    }

    // ── Actions ──────────────────────────────────────────────────────

    // Loads the realm's config; then, when the page came back from a federated
    // provider, completes that sign-in with the original authorize request.
    public async Load(): Promise<void>
    {
        const V = IdpLoginViewModel
        const pending = this.roundTrip.Take(this.location.Request)
        if (pending !== undefined)
        {
            this.page = this.location.WithRequest(pending.Request)
        }
        try
        {
            this.config = await this.backend.LoadConfig()
        }
        catch
        {
            this.isLoading = false
            this.SetMessage(V.ConfigUnavailableMessage, V.NoText)
            return
        }
        const config = this.config
        this.isLoading = false
        if (config.IdentityPlatform !== null)
        {
            this.identityPlatform = IdentityPlatformRestClient.For(config.IdentityPlatform, this.fetchFn)
        }
        for (const source of config.Sources)
        {
            this.sources.Add(new LoginSourceViewModel(source.Id, source.Label, source.Login + this.page.Request, this.navigator))
        }
        if (this.page.LoginHint !== V.NoText)
        {
            this.Email = this.page.LoginHint
        }
        if (this.page.PromptsCreate && this.OffersSignUp)
        {
            this.mode = LoginMode.SignUp
        }
        if (!this.ShowsPasswordForm && this.sources.Count === 0 && !this.ShowsGoogle)
        {
            this.errorText = V.NoMethodMessage
        }
        this.Refresh()
        if (pending !== undefined && this.identityPlatform !== undefined)
        {
            await this.CompleteFederated(pending, this.identityPlatform)
        }
    }

    // Signs in with the email and password: through Identity Platform when the
    // realm enables its email/password provider (falling back to the realm's
    // local accounts when Identity Platform rejects the credentials and the
    // realm has local accounts), else against the local accounts.
    public async SignIn(): Promise<void>
    {
        if (!this.CanSignIn)
        {
            return
        }
        const email = this.email.trim()
        const password = this.password
        this.Begin()
        const client = this.UsesIdentityPlatformPassword ? this.identityPlatform : undefined
        if (client === undefined)
        {
            await this.PostPassword(email, password)
            return
        }
        let idToken: string
        try
        {
            idToken = (await client.SignInWithPassword(email, password)).IdToken
        }
        catch (e)
        {
            const code = IdpLoginViewModel.CodeOf(e)
            if (this.config?.Local === true && code !== undefined && IdpLoginViewModel.IpCredentialCodes.includes(code))
            {
                await this.PostPassword(email, password)
                return
            }
            this.Fail(IdpLoginViewModel.MessageFor(code))
            return
        }
        await this.PostIdToken(idToken)
    }

    // Creates an Identity Platform account, sends its verification email and
    // returns to the sign-in form.
    public async SignUp(): Promise<void>
    {
        const V = IdpLoginViewModel
        const client = this.identityPlatform
        if (!this.CanSignUp || client === undefined)
        {
            return
        }
        const email = this.email.trim()
        const password = this.password
        const matches = password === this.confirmPassword
        this.Begin()
        if (!matches)
        {
            this.Fail(V.MismatchMessage)
            return
        }
        let idToken: string
        try
        {
            idToken = (await client.SignUp(email, password)).IdToken
        }
        catch (e)
        {
            this.Fail(V.MessageFor(V.CodeOf(e)))
            return
        }
        this.mode = LoginMode.SignIn
        try
        {
            await client.SendEmailVerification(idToken)
        }
        catch
        {
            this.unverifiedToken = idToken
            this.Fail(V.VerificationNotSentMessage)
            return
        }
        this.Done(V.CheckEmailMessage)
    }

    // Sends a password-reset email; the answer never says whether the account exists.
    public async SendReset(): Promise<void>
    {
        const V = IdpLoginViewModel
        const client = this.identityPlatform
        if (!this.CanSendReset || client === undefined)
        {
            return
        }
        const email = this.email.trim()
        this.Begin()
        try
        {
            await client.SendPasswordReset(email)
        }
        catch (e)
        {
            const code = V.CodeOf(e)
            if (code !== V.IpEmailNotFound)
            {
                this.Fail(V.MessageFor(code))
                return
            }
        }
        this.mode = LoginMode.SignIn
        this.Done(V.ResetSentMessage)
    }

    // Sends the verification email again, with the ID token of the refused sign-in.
    public async ResendVerification(): Promise<void>
    {
        const V = IdpLoginViewModel
        const client = this.identityPlatform
        const idToken = this.unverifiedToken
        if (this.isBusy || client === undefined || idToken === undefined)
        {
            return
        }
        this.Begin()
        try
        {
            await client.SendEmailVerification(idToken)
        }
        catch (e)
        {
            this.unverifiedToken = idToken
            this.Fail(V.MessageFor(V.CodeOf(e)))
            return
        }
        this.Done(V.VerificationResentMessage)
    }

    // Starts Continue with Google: asks Identity Platform for Google's sign-in
    // URL (coming back to this page with the same authorize request), saves the
    // round trip and navigates there.
    public async SignInWithGoogle(): Promise<void>
    {
        const V = IdpLoginViewModel
        const federation = this.identityPlatform
        if (this.isBusy || federation === undefined || !this.ShowsGoogle)
        {
            return
        }
        this.Begin()
        try
        {
            const start = await federation.CreateAuthUri(IdentityPlatformProvider.Google, this.page.ContinueUrl)
            this.roundTrip.Save(new PendingFederatedSignIn(start.SessionId, this.page.Request, this.page.IssuerPath))
            this.navigator.Assign(start.AuthUri)
        }
        catch (e)
        {
            this.Fail(V.MessageFor(V.CodeOf(e)))
        }
    }

    // The page came back without a navigation (the browser's back/forward
    // cache restored it after a post): usable again, without any password.
    public Reset(): void
    {
        this.ClearPasswords()
        this.isBusy = false
        this.Refresh()
    }

    // ── Internals ────────────────────────────────────────────────────

    private async CompleteFederated(pending: PendingFederatedSignIn, federation: IdentityPlatformRestClient): Promise<void>
    {
        const V = IdpLoginViewModel
        this.Begin()
        let idToken: string
        try
        {
            // The provider answers in the fragment: the whole URL, never origin + path + query.
            idToken = (await federation.SignInWithIdp(this.location.Href, pending.SessionId)).IdToken
        }
        catch (e)
        {
            this.Fail(V.CodeOf(e) === V.IpUserDisabled ? V.DisabledMessage : V.GoogleFailedMessage)
            return
        }
        await this.PostIdToken(idToken)
    }

    private async PostPassword(email: string, password: string): Promise<void>
    {
        const V = IdpLoginViewModel
        const answer = await this.backend.Post({
            [V.RequestField]: this.page.Request,
            [V.MethodField]: V.PasswordMethod,
            [V.EmailField]: email,
            [V.PasswordField]: password,
        })
        this.Answer(answer, undefined)
    }

    private async PostIdToken(idToken: string): Promise<void>
    {
        const V = IdpLoginViewModel
        const answer = await this.backend.Post({
            [V.RequestField]: this.page.Request,
            [V.MethodField]: V.IdentityPlatformMethod,
            [V.IdTokenField]: idToken,
        })
        this.Answer(answer, idToken)
    }

    // Follows a redirect (the page stays busy while it navigates) or shows the refusal.
    private Answer(answer: LoginAnswer, idToken: string | undefined): void
    {
        const V = IdpLoginViewModel
        if (answer.Redirect !== undefined)
        {
            this.navigator.Assign(answer.Redirect)
            return
        }
        switch (answer.Error)
        {
            case LoginAnswer.InvalidCredentials:
                this.Fail(V.InvalidCredentialsMessage)
                return
            case LoginAnswer.EmailNotVerified:
                this.unverifiedToken = idToken
                this.Fail(V.EmailNotVerifiedMessage)
                return
            case LoginAnswer.TooManyAttempts:
                this.Fail(answer.RetryAfterSeconds === undefined
                    ? V.TooManyAttemptsMessage
                    : V.TooManyAttemptsPrefix + String(answer.RetryAfterSeconds) + V.TooManyAttemptsSuffix)
                return
            case LoginAnswer.Unavailable:
                this.Fail(V.UnavailableMessage)
                return
            default:
                this.Fail(answer.Description ?? V.BadRequestMessage)
        }
    }

    // The text for an Identity Platform error code (undefined: not an Identity Platform answer).
    private static MessageFor(code: string | undefined): string
    {
        const V = IdpLoginViewModel
        switch (code)
        {
            case V.IpInvalidCredentials:
            case V.IpEmailNotFound:
            case V.IpInvalidPassword:
                return V.InvalidCredentialsMessage
            case V.IpEmailExists:
                return V.EmailExistsMessage
            case V.IpWeakPassword:
                return V.WeakPasswordMessage
            case V.IpInvalidEmail:
                return V.InvalidEmailMessage
            case V.IpUserDisabled:
                return V.DisabledMessage
            case V.IpTooManyAttempts:
                return V.TooManyAttemptsMessage
            default:
                return V.UnavailableMessage
        }
    }

    private static CodeOf(error: unknown): string | undefined
    {
        return error instanceof IdentityPlatformRestError ? error.Code : undefined
    }

    private OnKey(args: unknown): void
    {
        const key = args as Partial<KeyEventArgs> | undefined
        if (key === undefined || key.Handled === true || key.Key !== Key.Return)
        {
            return
        }
        const command = this.mode === LoginMode.SignUp ? this.signUpCommand : this.mode === LoginMode.Forgot ? this.sendResetCommand : this.signInCommand
        if (!command.CanExecute())
        {
            return
        }
        key.Handled = true
        command.Execute()
    }

    private SwitchTo(mode: LoginMode): void
    {
        if (this.isBusy)
        {
            return
        }
        this.mode = mode
        this.ClearPasswords()
        this.unverifiedToken = undefined
        this.SetMessage(IdpLoginViewModel.NoText, IdpLoginViewModel.NoText)
    }

    private get UsesIdentityPlatformPassword(): boolean
    {
        return this.config?.IdentityPlatform?.Enables(IdentityPlatformProvider.Password) === true
    }

    // Sign-up is offered when the realm allows it and its Identity Platform takes email/password accounts.
    private get OffersSignUp(): boolean
    {
        return this.config?.SignUp === true && this.UsesIdentityPlatformPassword
    }

    private get HasEmail(): boolean
    {
        return this.email.trim() !== IdpLoginViewModel.NoText
    }

    private get CanSignIn(): boolean
    {
        return !this.isBusy && this.ShowsSignInButton && this.HasEmail && this.password !== IdpLoginViewModel.NoText
    }

    private get CanSignUp(): boolean
    {
        return !this.isBusy && this.ShowsSignUpButton && this.HasEmail
            && this.password !== IdpLoginViewModel.NoText && this.confirmPassword !== IdpLoginViewModel.NoText
    }

    private get CanSendReset(): boolean
    {
        return !this.isBusy && this.ShowsResetButton && this.HasEmail
    }

    // An action starts: the passwords are dropped from the form, messages cleared, the form busy.
    private Begin(): void
    {
        this.ClearPasswords()
        this.unverifiedToken = undefined
        this.isBusy = true
        this.errorText = IdpLoginViewModel.NoText
        this.noticeText = IdpLoginViewModel.NoText
        this.Refresh()
    }

    private Fail(message: string): void
    {
        this.isBusy = false
        this.SetMessage(message, IdpLoginViewModel.NoText)
    }

    private Done(notice: string): void
    {
        this.isBusy = false
        this.SetMessage(IdpLoginViewModel.NoText, notice)
    }

    private SetMessage(error: string, notice: string): void
    {
        this.errorText = error
        this.noticeText = notice
        this.Refresh()
    }

    private ClearPasswords(): void
    {
        this.Password = IdpLoginViewModel.NoText
        this.ConfirmPassword = IdpLoginViewModel.NoText
    }

    // Announces every derived property whose value changed, then re-queries the commands.
    private Refresh(): void
    {
        for (const name of IdpLoginViewModel.DerivedProperties)
        {
            const next = this.Read(name)
            const old = this.announced.get(name)
            if (old !== next)
            {
                this.announced.set(name, next)
                this.RaisePropertyChanged(name, old, next)
            }
        }
        this.RaiseCommands()
    }

    private Remember(): void
    {
        for (const name of IdpLoginViewModel.DerivedProperties)
        {
            this.announced.set(name, this.Read(name))
        }
    }

    private Read(name: string): unknown
    {
        return (this as unknown as Record<string, unknown>)[name]
    }

    private RaiseCommands(): void
    {
        for (const command of this.commands)
        {
            command.RaiseCanExecuteChanged()
        }
    }
}
