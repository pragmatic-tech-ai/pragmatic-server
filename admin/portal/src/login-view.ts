import { TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import type { ControlPlaneClient } from './api-client.js'
import type { IPortalNavigator } from './portal-types.js'
import { PortalViewBase } from './portal-view-base.js'

// Operator sign-in form: email + password, Login button, inline error line.
// NOTE: Mural's TextBox has no masked/password mode, so the password is a plain TextBox.
export class LoginView extends PortalViewBase
{
    public static readonly LoginLabel = 'Login'
    public static readonly EmailPlaceholder = 'Email'
    public static readonly PasswordPlaceholder = 'Password'
    private static readonly HeadingText = 'Operator sign in'

    private readonly emailBox = new TextBox()
    private readonly passwordBox = new TextBox()

    public constructor(private readonly client: ControlPlaneClient, private readonly nav: IPortalNavigator)
    {
        super()
        const heading = new TextBlock()
        heading.Text = LoginView.HeadingText
        this.AddChild(heading)

        this.emailBox.Placeholder = LoginView.EmailPlaceholder
        this.AddChild(this.emailBox)

        this.passwordBox.Placeholder = LoginView.PasswordPlaceholder
        this.AddChild(this.passwordBox)

        this.AddChild(this.MakeButton(LoginView.LoginLabel, () => { void this.Submit() }))
        this.AddChild(this.message)
    }

    public async Refresh(): Promise<void>
    {
        // Nothing to load.
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
