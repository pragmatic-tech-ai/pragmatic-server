import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BundleBuilder, EnvKind } from './bundle.js'
import type { EnvDefinition, TenantPurposeName } from './bundle.js'
import { DockerEnv } from './docker.js'
import { UserSeeder } from './users.js'
import type { UserSeed } from './users.js'

export enum Command
{
    Up,
    Down,
    Status,
    Logs,
    SeedUsers,
    Build,
}

/** Operator CLI: brings local dev/demo environments up and down and seeds demo users. */
export class SeedCli
{
    private static readonly UpWord = 'up'
    private static readonly DownWord = 'down'
    private static readonly StatusWord = 'status'
    private static readonly LogsWord = 'logs'
    private static readonly SeedUsersWord = 'seed-users'
    private static readonly BuildWord = 'build'
    private static readonly UnknownCommandPrefix = 'unknown command: '
    private static readonly UsageMessage = 'usage: seed.ts <up|down|status|logs|seed-users|build> <env>'
    private static readonly EnvFile = 'env.json'
    private static readonly SeedDir = 'seed'
    private static readonly UsersFile = 'users.json'
    private static readonly SecretsFile = 'provisioned-secrets.json'
    private static readonly Utf8 = 'utf8'
    private static readonly HttpScheme = 'http://'
    private static readonly WsScheme = 'ws://'
    private static readonly LocalHost = '127.0.0.1'
    private static readonly PortSeparator = ':'
    private static readonly AdminEmailPrefix = 'admin@'
    private static readonly AdminEmailSuffix = '.test'
    private static readonly AdminSecretSuffix = '-admin-pw'
    private static readonly MissingSecretPrefix = 'missing secret in provisioned-secrets.json: '
    private static readonly BuildCommandPrefix = 'DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<path-to>/.npmrc -t '
    private static readonly BuildCommandSuffix = ' ..'
    private static readonly BuildNote = 'Run from the workspace parent dir (one level above pragmatic-server):\n  '
    private static readonly SeedingUsersMessage = 'Seeding demo users...'
    private static readonly SeededMessage = 'Demo users seeded.'
    private static readonly EnvRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

    public static Parse(argv: string[]): { command: Command; env: string }
    {
        const command = SeedCli.CommandFor(argv[0])
        const env = argv[1]
        if (env === undefined || env === '')
        {
            throw new Error(SeedCli.UsageMessage)
        }
        return { command, env }
    }

    public static EnvDir(env: string): string
    {
        return join(SeedCli.EnvRoot, env)
    }

    /** Loads environments/(env)/env.json; the JSON's numeric purpose (0/1) maps to the string enum. */
    public static LoadDefinition(env: string): EnvDefinition
    {
        const json = JSON.parse(readFileSync(join(SeedCli.EnvDir(env), SeedCli.EnvFile), SeedCli.Utf8)) as { name: string; kind: EnvKind; tenantId: string; purpose: number; hostPort: number }
        return { name: json.name, kind: json.kind, tenantId: json.tenantId, purpose: String(json.purpose) as TenantPurposeName, hostPort: json.hostPort }
    }

    /** Reads the generated provisioned-secrets.json (secretRef to value) for an environment. */
    public static LoadSecrets(env: string): Record<string, string>
    {
        return JSON.parse(readFileSync(join(SeedCli.EnvDir(env), SeedCli.SecretsFile), SeedCli.Utf8)) as Record<string, string>
    }

    public static HttpUrl(def: EnvDefinition): string
    {
        return SeedCli.HttpScheme + SeedCli.LocalHost + SeedCli.PortSeparator + def.hostPort
    }

    public static WsUrl(def: EnvDefinition): string
    {
        return SeedCli.WsScheme + SeedCli.LocalHost + SeedCli.PortSeparator + def.hostPort
    }

    public static AdminEmail(def: EnvDefinition): string
    {
        return SeedCli.AdminEmailPrefix + def.tenantId + SeedCli.AdminEmailSuffix
    }

    /** The admin password for the tenant, resolved from the generated secrets under (tenant)-admin-pw. */
    public static AdminPassword(def: EnvDefinition, secrets: Record<string, string>): string
    {
        return SeedCli.Secret(secrets, def.tenantId + SeedCli.AdminSecretSuffix)
    }

    public static async Run(command: Command, env: string): Promise<void>
    {
        const def = SeedCli.LoadDefinition(env)
        const bundleDir = SeedCli.EnvDir(env)
        const docker = new DockerEnv()
        switch (command)
        {
            case Command.Up:
                await SeedCli.Up(docker, def, bundleDir)
                break
            case Command.Down:
                await docker.Down(def)
                break
            case Command.Status:
                console.log(await docker.Status())
                break
            case Command.Logs:
                console.log(await docker.Logs(def))
                break
            case Command.SeedUsers:
                await SeedCli.SeedDemoUsers(def)
                break
            case Command.Build:
                console.log(SeedCli.BuildNote + SeedCli.BuildCommandPrefix + DockerEnv.ImageName + SeedCli.BuildCommandSuffix)
                break
        }
    }

    public static async Main(argv: string[]): Promise<void>
    {
        const parsed = SeedCli.Parse(argv)
        await SeedCli.Run(parsed.command, parsed.env)
    }

    /** True when this module is the process entry point (not when imported by tests or the smoke). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }

    private static CommandFor(word: string | undefined): Command
    {
        switch (word)
        {
            case SeedCli.UpWord:
                return Command.Up
            case SeedCli.DownWord:
                return Command.Down
            case SeedCli.StatusWord:
                return Command.Status
            case SeedCli.LogsWord:
                return Command.Logs
            case SeedCli.SeedUsersWord:
                return Command.SeedUsers
            case SeedCli.BuildWord:
                return Command.Build
            default:
                throw new Error(SeedCli.UnknownCommandPrefix + word)
        }
    }

    private static async Up(docker: DockerEnv, def: EnvDefinition, bundleDir: string): Promise<void>
    {
        await docker.EnsureImage()
        await BundleBuilder.Generate(def, bundleDir)
        await docker.SeedVolume(def, bundleDir)
        await docker.Up(def, bundleDir)
        await docker.WaitHealthy(def.hostPort, def)
        if (def.kind === EnvKind.Demo)
        {
            await SeedCli.SeedDemoUsers(def)
        }
    }

    private static async SeedDemoUsers(def: EnvDefinition): Promise<void>
    {
        console.log(SeedCli.SeedingUsersMessage)
        const secrets = SeedCli.LoadSecrets(def.name)
        const users = JSON.parse(readFileSync(join(SeedCli.EnvDir(def.name), SeedCli.SeedDir, SeedCli.UsersFile), SeedCli.Utf8)) as UserSeed[]
        for (const user of users)
        {
            user.password = SeedCli.Secret(secrets, user.passwordRef)
        }
        const seeder = new UserSeeder()
        const token = await seeder.Login(SeedCli.HttpUrl(def), def.tenantId, SeedCli.AdminEmail(def), SeedCli.AdminPassword(def, secrets))
        const conn = await seeder.Connect(SeedCli.WsUrl(def), def.tenantId, token)
        try
        {
            await seeder.SeedUsers(conn, users)
        }
        finally
        {
            conn.dispose()
        }
        console.log(SeedCli.SeededMessage)
    }

    private static Secret(secrets: Record<string, string>, ref: string): string
    {
        const value = secrets[ref]
        if (value === undefined)
        {
            throw new Error(SeedCli.MissingSecretPrefix + ref)
        }
        return value
    }
}

if (SeedCli.IsEntryPoint())
{
    SeedCli.Main(process.argv.slice(2)).catch(err =>
    {
        console.error(err instanceof Error ? err.message : err)
        process.exit(1)
    })
}
