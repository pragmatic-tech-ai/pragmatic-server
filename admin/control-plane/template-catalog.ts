import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnvKind, TenantPurposeName, type EnvDefinition } from '../../environments/seed/bundle.js'
import { Template } from './environment-record.js'

export class InvalidEnvironmentNameError extends Error
{
    private static readonly MessagePrefix = 'Invalid environment name '
    private static readonly MessageMiddle = ': must match '

    public constructor(input: string, allowedPattern: string)
    {
        super(`${InvalidEnvironmentNameError.MessagePrefix}${JSON.stringify(input)}${InvalidEnvironmentNameError.MessageMiddle}${allowedPattern}`)
        this.name = 'InvalidEnvironmentNameError'
    }
}

export class TemplateCatalog
{
    private static readonly NamePattern = /^[a-z0-9][a-z0-9-]*$/
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

    public static Resolve(template: Template, name: string, hostPort: number): { def: EnvDefinition; seedDir: string }
    {
        const safe = TemplateCatalog.SanitizeName(name)
        const here = dirname(fileURLToPath(import.meta.url))
        if (template === Template.DemoContoso)
        {
            return {
                def: { name: safe, kind: EnvKind.Demo, tenantId: TemplateCatalog.DemoTenantId, purpose: TenantPurposeName.Runtime, hostPort },
                seedDir: join(here, TemplateCatalog.ParentSegment, TemplateCatalog.ParentSegment, TemplateCatalog.EnvironmentsSegment, TemplateCatalog.DemoSegment, TemplateCatalog.SeedSegment),
            }
        }
        return {
            def: { name: safe, kind: EnvKind.Dev, tenantId: safe, purpose: TenantPurposeName.Development, hostPort },
            seedDir: join(here, TemplateCatalog.TemplatesSegment, TemplateCatalog.DevBlankSegment),
        }
    }
}
