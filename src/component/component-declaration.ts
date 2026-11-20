import { ComponentDescriptorBuilder, type ComponentDescriptor, type JsonValue, type OptionBuilder, type SettingBuilder, type SettingType } from '@pragmatic-tech-ai/pragmatic-component'

/** One setting as an application reads it today: the environment variable (or file) it comes from and what it means. */
export type SettingDeclaration = {
    name: string
    type: SettingType
    /** The environment variable the code reads the value from (for a secret: the one naming the mounted secret file);
     *  absent for a setting the application reads from its applied configuration document instead. */
    source?: string
    description: string
    required?: boolean
    secret?: boolean
    default?: JsonValue
}

export type OptionDeclaration = { name: string; description: string; settings: readonly SettingDeclaration[] }

export type RoleDeclaration = { name: string; description: string }

export type PortDeclaration = { name: string; number: number }

/**
 * What one application supports, as plain data held by the application's descriptor class (next to its composition root):
 * the options and settings its configuration readers actually read, its application roles, whether it needs a Postgres
 * database, and the ports and health endpoint it serves.
 */
export type ComponentDeclaration = {
    name: string
    options: readonly OptionDeclaration[]
    roles: readonly RoleDeclaration[]
    postgres: boolean
    ports: readonly PortDeclaration[]
    health?: { port: string; path: string }
}

/** Builds a declaration into a `ComponentDescriptor` through `ComponentDescriptorBuilder` (which enforces every descriptor rule). */
export class ComponentDeclarations
{
    /**
     * The version every pragmatic-server component descriptor carries: the server package's version (a test pins the two
     * together). Not the release version, so an unchanged application keeps its descriptor (and image) digest across releases.
     */
    public static readonly Version = '0.1.0'

    private static readonly SourceSeparator = ': '

    public static Build(declaration: ComponentDeclaration): ComponentDescriptor
    {
        const builder = new ComponentDescriptorBuilder(declaration.name, ComponentDeclarations.Version)
        for (const option of declaration.options)
        {
            builder.Option(option.name, option.description, built => ComponentDeclarations.Settings(built, option.settings))
        }
        for (const role of declaration.roles)
        {
            builder.Role(role.name, role.description)
        }
        if (declaration.postgres)
        {
            builder.Postgres()
        }
        for (const port of declaration.ports)
        {
            builder.Port(port.name, port.number)
        }
        if (declaration.health !== undefined)
        {
            builder.Health(declaration.health.port, declaration.health.path)
        }
        return builder.Build()
    }

    private static Settings(option: OptionBuilder, settings: readonly SettingDeclaration[]): OptionBuilder
    {
        for (const setting of settings)
        {
            option.Setting(setting.name, setting.type, built => ComponentDeclarations.Setting(built, setting))
        }
        return option
    }

    private static Setting(builder: SettingBuilder, setting: SettingDeclaration): SettingBuilder
    {
        builder.Description(setting.source === undefined ? setting.description : setting.source + ComponentDeclarations.SourceSeparator + setting.description)
        if (setting.required === true)
        {
            builder.Required()
        }
        if (setting.secret === true)
        {
            builder.Secret()
        }
        if (setting.default !== undefined)
        {
            builder.Default(setting.default)
        }
        return builder
    }
}
