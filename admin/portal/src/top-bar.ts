import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Application, Key, ThemeManager, type KeyEventArgs } from '@pragmatic-tech-ai/mural/runtime'
import { PragmaticDark, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { Brush } from '@pragmatic-tech-ai/mural/visual-engine'
import { Act, ActVariant } from './kit/act.js'
import { NavModel, PaSection } from './nav-model.js'

export interface TopBarInputs
{
    context: string
    onJump: (section: PaSection) => void
    onLogout: () => void
    operatorEmail: string
}

// Vertical host: the bar row (context label, destination search, theme toggle, operator email + Logout)
// above an empty BannerSlot. Bar surface: Bg1. The search box sets SubmitsOnEnter so a plain Enter
// bubbles unhandled to this bar's KeyDown listener, which jumps to the first matching destination.
export class TopBar extends StackPanel
{
    public static readonly SurfaceKey = 'Bg1'
    public static readonly LogoutLabel = 'Logout'
    public static readonly SearchPlaceholder = 'Jump to...'
    public static readonly ThemeToggleLabel = 'Toggle theme'
    private static readonly KeyDownEvent = 'KeyDown'
    private static readonly Light = 'light'
    private static readonly Dark = 'dark'

    private readonly bar = new StackPanel()
    private readonly spacer = new StackPanel()
    private readonly bannerSlot = new StackPanel()
    private readonly searchBox = new TextBox()
    private readonly contextLabel = new TextBlock()
    private readonly emailLabel = new TextBlock()
    private readonly themeToggle: Act
    private readonly logoutButton: Act
    private scheme: 'light' | 'dark' = TopBar.Light

    public constructor(private readonly inputs: TopBarInputs)
    {
        super()
        this.Orientation = Orientation.Vertical
        this.bar.Orientation = Orientation.Horizontal
        this.bar.Fill = Application.ResolveDefaultResource<Brush>(TopBar.SurfaceKey)

        this.contextLabel.Text = inputs.context
        this.bar.AddChild(this.contextLabel)

        this.searchBox.Placeholder = TopBar.SearchPlaceholder
        this.searchBox.SubmitsOnEnter = true
        this.bar.AddChild(this.searchBox)
        this.bar.AddChild(this.spacer)

        this.themeToggle = new Act({ can: true, label: TopBar.ThemeToggleLabel, variant: ActVariant.Secondary, onClick: () => this.ToggleTheme() })
        this.bar.AddChild(this.themeToggle)

        this.emailLabel.Text = inputs.operatorEmail
        this.bar.AddChild(this.emailLabel)
        this.logoutButton = new Act({ can: true, label: TopBar.LogoutLabel, variant: ActVariant.Secondary, onClick: () => this.Logout() })
        this.bar.AddChild(this.logoutButton)

        this.AddChild(this.bar)
        this.AddChild(this.bannerSlot)
        this.AddRoutedEventListener(TopBar.KeyDownEvent, ((args: KeyEventArgs) => this.OnEnterKey(args)) as (a: unknown) => void)
    }

    public get Context(): string
    {
        return this.inputs.context
    }

    public get SearchText(): string
    {
        return this.searchBox.Text
    }

    public SetSearch(text: string): void
    {
        this.searchBox.Text = text
    }

    // Resolves the current query to a section; calls onJump only when a destination matches.
    public Jump(): void
    {
        const section = TopBar.MatchSection(this.searchBox.Text)
        if (section !== undefined)
        {
            this.inputs.onJump(section)
        }
    }

    // Case-folded substring match over nav item labels; first match wins.
    public static MatchSection(query: string): PaSection | undefined
    {
        const q = query.trim().toLowerCase()
        if (q.length === 0)
        {
            return undefined
        }
        for (const group of NavModel.Groups)
        {
            for (const item of group.items)
            {
                if (item.Label.toLowerCase().includes(q))
                {
                    return item.Section
                }
            }
        }
        return undefined
    }

    public get CurrentScheme(): 'light' | 'dark'
    {
        return this.scheme
    }

    // Flips light <-> dark and performs a real runtime scheme swap.
    public ToggleTheme(): void
    {
        const toDark = this.scheme === TopBar.Light
        this.scheme = toDark ? TopBar.Dark : TopBar.Light
        ThemeManager.ApplyScheme(toDark ? PragmaticDark.instance : PragmaticLight.instance)
    }

    public get OperatorEmail(): string
    {
        return this.inputs.operatorEmail
    }

    public Logout(): void
    {
        this.inputs.onLogout()
    }

    public get BannerSlot(): StackPanel
    {
        return this.bannerSlot
    }

    private OnEnterKey(args: KeyEventArgs): void
    {
        if (args.Handled || args.Key !== Key.Return) return
        args.Handled = true
        this.Jump()
    }
}
