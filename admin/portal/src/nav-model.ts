import { KitGlyph } from './kit/icon-catalog.js'

export enum PaSection
{
    Fleet = 'fleet',
    Clients = 'clients',
    Tenants = 'tenants',
    Hives = 'hives',
    Registry = 'registry',
    ReleasePolicy = 'release-policy',
    AgentChannel = 'agent-channel',
    PlatformComponents = 'platform-components',
    Settings = 'settings',
}

export interface NavItem
{
    Label: string
    Glyph: KitGlyph
    Section: PaSection
}

export interface NavGroup
{
    heading?: string
    items: readonly NavItem[]
}

// The platform-admin grouped left-nav information architecture (nine sections).
export class NavModel
{
    private static readonly FleetLabel = 'Fleet'
    private static readonly ClientsLabel = 'Clients'
    private static readonly TenantsLabel = 'Tenants'
    private static readonly HivesLabel = 'Hives'
    private static readonly RegistryLabel = 'Registry & Releases'
    private static readonly ReleasePolicyLabel = 'Release Policy'
    private static readonly AgentChannelLabel = 'Agent Channel'
    private static readonly PlatformComponentsLabel = 'Platform Components'
    private static readonly SettingsLabel = 'Settings'
    private static readonly ProvisioningHeading = 'Provisioning'
    private static readonly ReleasesHeading = 'Releases'
    private static readonly ChannelHeading = 'Channel & software'

    public static readonly Groups: readonly NavGroup[] = [
        {
            items: [{ Label: NavModel.FleetLabel, Glyph: KitGlyph.Server, Section: PaSection.Fleet }],
        },
        {
            heading: NavModel.ProvisioningHeading,
            items: [
                { Label: NavModel.ClientsLabel, Glyph: KitGlyph.Building, Section: PaSection.Clients },
                { Label: NavModel.TenantsLabel, Glyph: KitGlyph.Users, Section: PaSection.Tenants },
                { Label: NavModel.HivesLabel, Glyph: KitGlyph.HardDrive, Section: PaSection.Hives },
            ],
        },
        {
            heading: NavModel.ReleasesHeading,
            items: [
                { Label: NavModel.RegistryLabel, Glyph: KitGlyph.Package, Section: PaSection.Registry },
                { Label: NavModel.ReleasePolicyLabel, Glyph: KitGlyph.Shield, Section: PaSection.ReleasePolicy },
            ],
        },
        {
            heading: NavModel.ChannelHeading,
            items: [
                { Label: NavModel.AgentChannelLabel, Glyph: KitGlyph.RadioTower, Section: PaSection.AgentChannel },
                { Label: NavModel.PlatformComponentsLabel, Glyph: KitGlyph.Layers, Section: PaSection.PlatformComponents },
            ],
        },
        {
            items: [{ Label: NavModel.SettingsLabel, Glyph: KitGlyph.Settings, Section: PaSection.Settings }],
        },
    ]

    public static ActiveFor(section: PaSection): PaSection
    {
        return section
    }

    public static LabelFor(section: PaSection): string
    {
        for (const group of NavModel.Groups)
        {
            for (const item of group.items)
            {
                if (item.Section === section)
                {
                    return item.Label
                }
            }
        }
        return section
    }
}
