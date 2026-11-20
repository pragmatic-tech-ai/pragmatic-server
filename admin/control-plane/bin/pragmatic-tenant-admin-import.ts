import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TenantAdminDatabase } from '../tenant-admin-database.js'
import { TenantAdminImport, TenantAdminImportRefusedError } from '../tenant-admin-import.js'

/** What the command line asked for. */
export class TenantAdminImportArguments
{
    public constructor(public readonly DataRoot: string, public readonly Force: boolean)
    {
    }
}

/**
 * The import of an in-hive tenant admin console's pre-A5 JSON data root into its Postgres database, run inside the
 * tenant-admin image: `node dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admin-import.js --data-root /data
 * [--force]`. The console also imports by itself at start when its database holds none of its records; this command is
 * for dev data and a forced re-run. The database is the console's own (PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE). The
 * data root is only read. Prints what it wrote as JSON; exits 2 on a usage error, 3 when the database already holds
 * records (pass --force to import over it), 1 on any other failure (its message never carries a secret).
 */
export class TenantAdminImportBin
{
    public static readonly DataRootFlag = '--data-root'
    public static readonly ForceFlag = '--force'
    public static readonly UsageExit = 2
    public static readonly RefusedExit = 3
    public static readonly FailedExit = 1
    private static readonly Usage = 'usage: pragmatic-tenant-admin-import --data-root <folder> [--force]   (PRAGMATIC_TENANT_ADMIN_DATABASE_URL_FILE names the database)'
    private static readonly FailurePrefix = 'pragmatic-tenant-admin-import: '
    private static readonly ArgumentsStart = 2
    private static readonly Blank = ''

    /** The parsed arguments, or undefined when they are not `--data-root <folder> [--force]`. */
    public static Parse(argv: readonly string[]): TenantAdminImportArguments | undefined
    {
        const B = TenantAdminImportBin
        let dataRoot: string | undefined
        let force = false
        for (let i = 0; i < argv.length; i++)
        {
            const arg = argv[i] as string
            if (arg === B.ForceFlag)
            {
                force = true
            }
            else if (arg === B.DataRootFlag && i + 1 < argv.length && dataRoot === undefined)
            {
                dataRoot = argv[++i] as string
            }
            else
            {
                return undefined
            }
        }
        return dataRoot === undefined || dataRoot.trim() === B.Blank ? undefined : new TenantAdminImportArguments(resolve(dataRoot), force)
    }

    /** Runs the import; answers the process exit code. `database` replaces the one the environment names (tests). */
    public static async Run(argv: readonly string[], env: NodeJS.ProcessEnv, out: (line: string) => void = console.log, err: (line: string) => void = console.error, database?: TenantAdminDatabase): Promise<number>
    {
        const B = TenantAdminImportBin
        const args = B.Parse(argv)
        if (args === undefined)
        {
            err(B.Usage)
            return B.UsageExit
        }
        let opened: TenantAdminDatabase | undefined
        try
        {
            opened = database ?? await TenantAdminDatabase.Open(env)
            const report = await new TenantAdminImport(args.DataRoot, opened).Run(args.Force)
            out(JSON.stringify(report.ToJson()))
            return 0
        }
        catch (e)
        {
            err(B.FailurePrefix + (e instanceof Error ? e.message : String(e)))
            return e instanceof TenantAdminImportRefusedError ? B.RefusedExit : B.FailedExit
        }
        finally
        {
            if (database === undefined)
            {
                await opened?.Close()
            }
        }
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
    }

    public static async Main(): Promise<void>
    {
        process.exitCode = await TenantAdminImportBin.Run(process.argv.slice(TenantAdminImportBin.ArgumentsStart), process.env)
    }
}

if (TenantAdminImportBin.IsEntryPoint())
{
    await TenantAdminImportBin.Main()
}
