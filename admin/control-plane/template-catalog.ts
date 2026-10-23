import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnvKind, TenantPurposeName, type EnvDefinition } from '../../environments/seed/bundle.js'
import { DockerEnv } from '../../environments/seed/docker.js'
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
    private static readonly RuntimePostgresTitle = 'Runtime environment with provisioned Postgres'
    /** Convention: the connector fixture authors connection = "appdb". */
    public static readonly DbConnectionName = 'appdb'
    private static readonly DbName = 'appdb'
    private static readonly DbUser = 'appuser'
    private static readonly DbPort = 5432
    private static readonly DbPasswordBytes = 24
    private static readonly HexEncoding = 'hex'
    private static readonly MaxPort = 65535
    private static readonly DbHostPortOffset = 10000

    public static All(): readonly { id: Template; title: string }[]
    {
        return [
            { id: Template.DevBlank, title: TemplateCatalog.DevBlankTitle },
            { id: Template.DemoContoso, title: TemplateCatalog.DemoContosoTitle },
            { id: Template.RuntimePostgres, title: TemplateCatalog.RuntimePostgresTitle },
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
        return template === Template.DemoContoso || template === Template.RuntimePostgres ? EnvType.Runtime : EnvType.Development
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

    /** Deterministic (so a re-derived def is stable) host port for the DB sidecar, offset from the server port. */
    private static DbHostPortFor(hostPort: number): number
    {
        const up = hostPort + TemplateCatalog.DbHostPortOffset
        return up <= TemplateCatalog.MaxPort ? up : hostPort - TemplateCatalog.DbHostPortOffset
    }

    public static Resolve(template: Template, name: string, hostPort: number, type: EnvType): { def: EnvDefinition; seedDir: string }
    {
        const safe = TemplateCatalog.SanitizeName(name)
        const purpose = TemplateCatalog.PurposeFor(type)
        if (template === Template.DemoContoso)
        {
            return {
                def: { name: safe, kind: EnvKind.Demo, environmentId: TemplateCatalog.DemoTenantId, purpose, hostPort },
                seedDir: join(TemplateCatalog.HereDir, TemplateCatalog.ParentSegment, TemplateCatalog.ParentSegment, TemplateCatalog.EnvironmentsSegment, TemplateCatalog.DemoSegment, TemplateCatalog.SeedSegment),
            }
        }
        if (template === Template.RuntimePostgres)
        {
            const def: EnvDefinition = { name: safe, kind: EnvKind.Dev, environmentId: safe, purpose, hostPort }
            def.database = {
                connectionName: TemplateCatalog.DbConnectionName,
                host: DockerEnv.DbContainerName(def),
                port: TemplateCatalog.DbPort,
                database: TemplateCatalog.DbName,
                user: TemplateCatalog.DbUser,
                password: randomBytes(TemplateCatalog.DbPasswordBytes).toString(TemplateCatalog.HexEncoding),
                hostPort: TemplateCatalog.DbHostPortFor(hostPort),
            }
            return { def, seedDir: join(TemplateCatalog.HereDir, TemplateCatalog.TemplatesSegment, TemplateCatalog.DevBlankSegment) }
        }
        return {
            def: { name: safe, kind: EnvKind.Dev, environmentId: safe, purpose, hostPort },
            seedDir: join(TemplateCatalog.HereDir, TemplateCatalog.TemplatesSegment, TemplateCatalog.DevBlankSegment),
        }
    }
}
