import type { AdminCapabilitiesDto } from '../tenant-types.js'

// The four tenant-administration permissions the profile reports. Every
// mutating command needs exactly one of them.
export enum AdminCapability
{
    Environments,
    Adopt,
    Access,
    Settings,
}

// What each permission is called on screen, and how it is read off the wire.
// Unknown capabilities (the profile could not be read) are permissive: the
// server is the gate, and it refuses what the operator may not do.
export class AdminCapabilities
{
    private static readonly EnvironmentsName = 'the Manage environments permission'
    private static readonly AdoptName = 'the Adopt versions permission'
    private static readonly AccessName = 'the Manage users & access permission'
    private static readonly SettingsName = 'the Manage tenant settings permission'

    public constructor(private readonly wire: AdminCapabilitiesDto | undefined)
    {
    }

    public Has(capability: AdminCapability): boolean
    {
        const wire = this.wire
        if (wire === undefined)
        {
            return true
        }
        switch (capability)
        {
            case AdminCapability.Environments:
                return wire.envs !== false
            case AdminCapability.Adopt:
                return wire.adopt !== false
            case AdminCapability.Access:
                return wire.access !== false
            case AdminCapability.Settings:
                return wire.settings !== false
        }
    }

    public static NameOf(capability: AdminCapability): string
    {
        switch (capability)
        {
            case AdminCapability.Environments:
                return AdminCapabilities.EnvironmentsName
            case AdminCapability.Adopt:
                return AdminCapabilities.AdoptName
            case AdminCapability.Access:
                return AdminCapabilities.AccessName
            case AdminCapability.Settings:
                return AdminCapabilities.SettingsName
        }
    }
}
