import { KitGlyph } from './kit/icon-catalog.js'

export enum NavSection
{
    Overview = 'overview',
    Environments = 'environments',
    UsersAccess = 'users-access',
    Releases = 'releases',
    Settings = 'settings',
    ConnectionStatus = 'connection-status',
}

export interface NavItem
{
    Label: string
    Glyph: KitGlyph
    Section: NavSection
}

// The tenant-admin left-nav information architecture.
export class NavModel
{
    private static readonly OverviewLabel = 'Overview'
    private static readonly EnvironmentsLabel = 'Environments'
    private static readonly UsersAccessLabel = 'Users & Access'
    private static readonly ReleasesLabel = 'Releases'
    private static readonly SettingsLabel = 'Settings'
    private static readonly ConnectionStatusLabel = 'Connection status'

    public static readonly Items: readonly NavItem[] = [
        { Label: NavModel.OverviewLabel, Glyph: KitGlyph.Home, Section: NavSection.Overview },
        { Label: NavModel.EnvironmentsLabel, Glyph: KitGlyph.Layers, Section: NavSection.Environments },
        { Label: NavModel.UsersAccessLabel, Glyph: KitGlyph.Users, Section: NavSection.UsersAccess },
        { Label: NavModel.ReleasesLabel, Glyph: KitGlyph.Package, Section: NavSection.Releases },
        { Label: NavModel.SettingsLabel, Glyph: KitGlyph.Settings, Section: NavSection.Settings },
        { Label: NavModel.ConnectionStatusLabel, Glyph: KitGlyph.RadioTower, Section: NavSection.ConnectionStatus },
    ]

    // Identity for the six sections. Environment/hive detail views are not separate
    // sections; the shell (Task 4) passes NavSection.Environments while showing a detail.
    public static ActiveFor(section: NavSection): NavSection
    {
        return section
    }
}
