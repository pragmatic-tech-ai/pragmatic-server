import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { Application, Key, ThemeManager, type KeyEventArgs } from '@pragmatic-tech-ai/mural/runtime'
import { PragmaticDark, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import type { Brush } from '@pragmatic-tech-ai/mural/visual-engine'
import { Act, ActVariant } from './kit/act.js'
import { NavModel, PaSection } from './nav-model.js'

export enum ThemeScheme
{
    Light,
    Dark,
}

export interface TopBarInputs
{
    context: string
    onJump: (section: PaSection) => void
    onLogout: () => void
    onLegacy: () => void
    operatorEmail: string
}

// Vertical host: the bar row (context label, destination search, theme toggle, operator email, Logout,
// and the dev-only legacy-tools entry) above an empty BannerSlot. Bar surface: Bg1. The search box leaves
// AcceptsReturn false (the default), so a plain Enter bubbles unhandled to this bar's KeyDown listener,
// which jumps to the first matching destination.
export class TopBar extends StackPanel
{
    public static readonly SurfaceKey = 'Bg1'
    public static readonly LogoutLabel = 'Logout'
    public static readonly LegacyLabel = 'Legacy environment tools (dev)'
    public static readonly SearchPlaceholder = 'Jump to...'
    public static readonly ThemeToggleLabel = 'Toggle theme'
    private static readonly KeyDownEvent = 'KeyDown'

    private readonly bar = new StackPanel()
    private readonly spacer = new StackPanel()
    private readonly bannerSlot = new StackPanel()
    private readonly searchBox = new TextBox()
    private readonly contextLabel = new TextBlock()
    private readonly emailLabel = new TextBlock()
    private readonly themeToggle: Act
    private readonly logoutButton: Act
    private readonly legacyButton: Act
    private scheme: ThemeScheme = ThemeScheme.Light

    public constructor(private readonly inputs: TopBarInputs)
    {
        super()
        this.Orientation = Orientation.Vertical
        this.bar.Orientation = Orientation.Horizontal
        this.bar.Fill = Application.ResolveDefaultResource<Brush>(TopBar.SurfaceKey)

        this.contextLabel.Text = inputs.context
        this.bar.AddChild(this.contextLabel)

        this.searchBox.Placeholder = TopBar.SearchPlaceholder
        this.bar.AddChild(this.searchBox)
        this.bar.AddChild(this.spacer)

        this.themeToggle = new Act({ can: true, label: TopBar.ThemeToggleLabel, variant: ActVariant.Secondary, onClick: () => this.ToggleTheme() })
        this.bar.AddChild(this.themeToggle)

        this.emailLabel.Text = inputs.operatorEmail
        this.bar.AddChild(this.emailLabel)
        this.logoutButton = new Act({ can: true, label: TopBar.LogoutLabel, variant: ActVariant.Secondary, onClick: () => this.Logout() })
        this.bar.AddChild(this.logoutButton)
        // Dev-only entry into the demoted legacy environment/graph tooling: sits in the operator-menu
        // region of the top bar, never in the primary nav. Keyboard-reachable (Act -> KeyActivatedButton).
        this.legacyButton = new Act({ can: true, label: TopBar.LegacyLabel, variant: ActVariant.Secondary, onClick: () => this.Legacy() })
        this.bar.AddChild(this.legacyButton)

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

    public get CurrentScheme(): ThemeScheme
    {
        return this.scheme
    }

    // Flips light <-> dark and performs a real runtime scheme swap.
    public ToggleTheme(): void
    {
        const toDark = this.scheme === ThemeScheme.Light
        this.scheme = toDark ? ThemeScheme.Dark : ThemeScheme.Light
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

    public Legacy(): void
    {
        this.inputs.onLegacy()
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
