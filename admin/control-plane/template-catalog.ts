import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnvKind, TenantPurposeName, type EnvDefinition } from '../../environments/seed/bundle.js'
import { Template, EnvType } from './environment-record.js'

export class InvalidEnvironmentNameError extends Error
{
    private static readonly MessagePrefix = 'Invalid environment name '
    private static readonly MessageMiddle = ': must match '
    private static readonly ErrorName = 'InvalidEnvironmentNameError'

    public constructor(input: string, allowedPattern: string)
    {
        super(`${InvalidEnvironmentNameError.MessagePrefix}${JSON.stringify(input)}${InvalidEnvironmentNameError.MessageMiddle}${allowedPattern}`)
        this.name = InvalidEnvironmentNameError.ErrorName
    }
}

export class TemplateCatalog
{
    private static readonly NamePattern = /^[a-z0-9][a-z0-9-]*$/
    private static readonly HereDir = dirname(fileURLToPath(import.meta.url))
    private static readonly DemoTenantId = 'contoso'
    private static readonly TemplatesSegment = 'templates'
    private static readonly DevBlankSegment = 'dev-blank'
    private static readonly ParentSegment = '..'
    private static readonly EnvironmentsSegment = 'environments'
    private static readonly DemoSegment = 'demo'
    private static readonly SeedSegment = 'seed'
    private static readonly DevBlankTitle = 'Blank development environment'
    private static readonly DemoContosoTitle = 'Contoso demo (runtime)'

    public static All(): readonly { id: Template; title: string }[]
    {
        return [
            { id: Template.DevBlank, title: TemplateCatalog.DevBlankTitle },
            { id: Template.DemoContoso, title: TemplateCatalog.DemoContosoTitle },
        ]
    }

    public static SanitizeName(name: string): string
    {
        if (!TemplateCatalog.NamePattern.test(name))
        {
            throw new InvalidEnvironmentNameError(name, TemplateCatalog.NamePattern.source)
        }
        return name
    }

    public static DefaultTypeFor(template: Template): EnvType
    {
        return template === Template.DemoContoso ? EnvType.Runtime : EnvType.Development
    }

    private static PurposeFor(type: EnvType): TenantPurposeName
    {
        switch (type)
        {
            case EnvType.Development:
                return TenantPurposeName.Development
            case EnvType.Runtime:
                return TenantPurposeName.Runtime
            default:
            {
                const _exhaustive: never = type
                return _exhaustive
            }
        }
    }

    public static Resolve(template: Template, name: string, hostPort: number, type: EnvType): { def: EnvDefinition; seedDir: string }
    {
        const safe = TemplateCatalog.SanitizeName(name)
        const purpose = TemplateCatalog.PurposeFor(type)
        if (template === Template.DemoContoso)
        {
            return {
                def: { name: safe, kind: EnvKind.Demo, tenantId: TemplateCatalog.DemoTenantId, purpose, hostPort },
                seedDir: join(TemplateCatalog.HereDir, TemplateCatalog.ParentSegment, TemplateCatalog.ParentSegment, TemplateCatalog.EnvironmentsSegment, TemplateCatalog.DemoSegment, TemplateCatalog.SeedSegment),
            }
        }
        return {
            def: { name: safe, kind: EnvKind.Dev, tenantId: safe, purpose, hostPort },
            seedDir: join(TemplateCatalog.HereDir, TemplateCatalog.TemplatesSegment, TemplateCatalog.DevBlankSegment),
        }
    }
}
