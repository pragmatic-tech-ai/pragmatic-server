import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Key, type KeyEventArgs } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import type { IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// Operator sign-in form: email + password, Login button, inline error line.
// The password box masks its glyphs (TextBox.IsPassword; Text still holds the real value). Both boxes
// set SubmitsOnEnter, so a plain Enter bubbles unhandled to this view's KeyDown listener, which submits.
export class LoginView extends PortalViewBase
{
    public static readonly LoginLabel = 'Login'
    public static readonly EmailPlaceholder = 'Email'
    public static readonly PasswordPlaceholder = 'Password'
    private static readonly HeadingText = 'Operator sign in'
    private static readonly KeyDownEvent = 'KeyDown'

    private readonly emailBox = new TextBox()
    private readonly passwordBox = new TextBox()

    public constructor(private readonly client: ControlPlaneClient, private readonly nav: IPortalNavigator)
    {
        super()
        const heading = new TextBlock()
        heading.Text = LoginView.HeadingText
        this.AddChild(heading)

        this.emailBox.Placeholder = LoginView.EmailPlaceholder
        this.emailBox.SubmitsOnEnter = true
        this.AddChild(this.emailBox)

        this.passwordBox.Placeholder = LoginView.PasswordPlaceholder
        this.passwordBox.IsPassword = true
        this.passwordBox.SubmitsOnEnter = true
        this.AddChild(this.passwordBox)

        this.AddChild(this.MakeButton(LoginView.LoginLabel, () => { void this.Submit() }))
        this.AddChild(this.message)

        this.AddRoutedEventListener(LoginView.KeyDownEvent, ((args: KeyEventArgs) => this.OnEnterKey(args)) as (a: unknown) => void)
    }

    public async Refresh(): Promise<void>
    {
        // Nothing to load.
    }

    // A plain Enter from either text box bubbles here (SubmitsOnEnter leaves it unhandled).
    private OnEnterKey(args: KeyEventArgs): void
    {
        if (args.Handled || args.Key !== Key.Return) return
        args.Handled = true
        void this.Submit()
    }

    private async Submit(): Promise<void>
    {
        try
        {
            await this.client.Login(this.emailBox.Text.trim(), this.passwordBox.Text)
        }
        catch (e)
        {
            this.ShowMessage(e)
            return
        }
        this.nav.ShowList()
    }
}
