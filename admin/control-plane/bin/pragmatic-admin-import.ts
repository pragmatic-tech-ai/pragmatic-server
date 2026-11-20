import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MasterKeyFile } from '../master-key-file.js'
import { PlatformAdminDatabase } from '../platform-admin-database.js'
import { PlatformAdminImport, PlatformAdminImportRefusedError } from '../platform-admin-import.js'
import { TenantPlaneComposer } from '../tenant-plane-composer.js'

/** What the command line asked for. */
export class AdminImportArguments
{
    public constructor(public readonly DataRoot: string, public readonly Force: boolean)
    {
    }
}

/**
 * The one-time import of the platform admin console's JSON data root into its Postgres database, run by the deploy step
 * inside the platform-admin image: `node dist-tenant-admin/admin/control-plane/bin/pragmatic-admin-import.js --data-root
 * /data [--force]`. The database is the console's own (PRAGMATIC_ADMIN_DATABASE_URL_FILE), the master key the console's
 * (PRAGMATIC_ADMIN_MASTER_KEY_FILE, default `<data root>/master.key`). The data root is only read. Prints what it wrote as
 * JSON; exits 2 on a usage error, 3 when the database already holds records (pass --force to import over it), 1 on any
 * other failure (its message never carries a secret).
 */
export class AdminImportBin
{
    public static readonly DataRootFlag = '--data-root'
    public static readonly ForceFlag = '--force'
    public static readonly MasterKeyEnvVar = 'PRAGMATIC_ADMIN_MASTER_KEY_FILE'
    public static readonly UsageExit = 2
    public static readonly RefusedExit = 3
    public static readonly FailedExit = 1
    private static readonly Usage = 'usage: pragmatic-admin-import --data-root <folder> [--force]   (PRAGMATIC_ADMIN_DATABASE_URL_FILE names the database)'
    private static readonly FailurePrefix = 'pragmatic-admin-import: '
    private static readonly ArgumentsStart = 2

    /** The parsed arguments, or undefined when they are not `--data-root <folder> [--force]`. */
    public static Parse(argv: readonly string[]): AdminImportArguments | undefined
    {
        const B = AdminImportBin
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
        return dataRoot === undefined || dataRoot.trim() === '' ? undefined : new AdminImportArguments(resolve(dataRoot), force)
    }

    /** Runs the import; answers the process exit code. */
    public static async Run(argv: readonly string[], env: NodeJS.ProcessEnv, out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<number>
    {
        const B = AdminImportBin
        const args = B.Parse(argv)
        if (args === undefined)
        {
            err(B.Usage)
            return B.UsageExit
        }
        let database: PlatformAdminDatabase | undefined
        try
        {
            const keyFile = env[B.MasterKeyEnvVar]?.trim() || join(args.DataRoot, TenantPlaneComposer.MasterKeyFileName)
            const masterKey = MasterKeyFile.Load(keyFile)
            database = await PlatformAdminDatabase.Open(env)
            const report = await new PlatformAdminImport(args.DataRoot, database, masterKey).Run(args.Force)
            out(JSON.stringify(report.ToJson()))
            return 0
        }
        catch (e)
        {
            err(B.FailurePrefix + (e instanceof Error ? e.message : String(e)))
            return e instanceof PlatformAdminImportRefusedError ? B.RefusedExit : B.FailedExit
        }
        finally
        {
            await database?.Close()
        }
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
    }

    public static async Main(): Promise<void>
    {
        process.exitCode = await AdminImportBin.Run(process.argv.slice(AdminImportBin.ArgumentsStart), process.env)
    }
}

if (AdminImportBin.IsEntryPoint())
{
    await AdminImportBin.Main()
}
