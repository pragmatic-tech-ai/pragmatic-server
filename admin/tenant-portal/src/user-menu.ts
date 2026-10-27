import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Act, ActVariant } from './kit/act.js'

export interface UserMenuInputs
{
    email: string
    onLogout: () => void
}

// Minimal inline user menu: avatar (email initials), email, Logout. Role label is deferred to TA-3.
export class UserMenu extends StackPanel
{
    public static readonly LogoutLabel = 'Logout'
    public static readonly UnknownInitials = '?'
    private static readonly AtSign = '@'
    private static readonly InitialsSplit = /[._-]+/
    private static readonly SingleInitialLength = 2

    private readonly logout: Act

    public constructor(inputs: UserMenuInputs)
    {
        super()
        this.Orientation = Orientation.Horizontal
        this.AddChild(UserMenu.MakeText(UserMenu.InitialsFor(inputs.email)))
        this.AddChild(UserMenu.MakeText(inputs.email))
        this.logout = new Act({ can: true, label: UserMenu.LogoutLabel, variant: ActVariant.Secondary, onClick: inputs.onLogout })
        this.AddChild(this.logout)
    }

    public get LogoutAction(): Act
    {
        return this.logout
    }

    // Initials come from the local part: split on . _ - and take the leading letters.
    public static InitialsFor(email: string): string
    {
        const local = email.split(UserMenu.AtSign)[0] ?? ''
        const parts = local.split(UserMenu.InitialsSplit).filter(p => p.length > 0)
        if (parts.length === 0)
        {
            return UserMenu.UnknownInitials
        }
        const letters = parts.length === 1 ? parts[0].slice(0, UserMenu.SingleInitialLength) : parts[0][0] + parts[1][0]
        return letters.toUpperCase()
    }

    private static MakeText(text: string): TextBlock
    {
        const block = new TextBlock()
        block.Text = text
        return block
    }
}
