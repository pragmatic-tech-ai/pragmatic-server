import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AuditRegistry } from './audit-record.js'
import { ConsoleDelivery } from './console-delivery.js'
import { ConsoleEmailDomainStore } from './console-email-domain-store.js'
import { ConsoleOwnerResetFollower } from './console-owner-reset-follower.js'
import { ConsoleRegistration } from './console-registration.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { FileRecordMap, RecordSlot, type FileRecordMapOptions } from './record-map.js'
import { TenantAdminDatabase, TenantAdminRegistry } from './tenant-admin-database.js'
import { TenantAdminClientRegistry } from './tenant-auth/tenant-admin-client-record.js'
import { TenantPlaneComposer } from './tenant-plane-composer.js'

/** One file of the console's pre-A5 data root and the table it goes to. */
class ConsoleDataRootFile
{
    public constructor(public readonly Registry: TenantAdminRegistry, public readonly FileName: string, public readonly Options: FileRecordMapOptions)
    {
    }
}

/**
 * The in-hive tenant admin console's JSON data root as the console wrote it before A5 (the layout of its data volume): one
 * `{ <root>: { <key>: record } }` file per registry, and the single-record files whose root object is the record map
 * (`email-domains.json` `{ domains }`, `console-registration.json` `{ state }`, `owner-reset-applied.json` `{ appliedAt }`).
 * The platform's delivery (`seed.json`, `verified-images.json`) sits beside them; it is stored under its record key.
 * Mirrored from the code that wrote it.
 */
export class TenantAdminDataRoot
{
    public static readonly SessionsFile = 'tenant-sessions.json'
    public static readonly Files: readonly ConsoleDataRootFile[] = [
        new ConsoleDataRootFile(TenantAdminRegistry.Environments, TenantPlaneComposer.RegistryFile, { RootKey: EnvironmentRegistry.RootKey }),
        new ConsoleDataRootFile(TenantAdminRegistry.TenantAdminClients, TenantPlaneComposer.TenantAdminClientsFile, { RootKey: TenantAdminClientRegistry.RootKey }),
        new ConsoleDataRootFile(TenantAdminRegistry.DesktopAudit, TenantPlaneComposer.DesktopAuditFile, { RootKey: AuditRegistry.RootKey }),
        new ConsoleDataRootFile(TenantAdminRegistry.GraphAudit, TenantPlaneComposer.TenantGraphAuditFile, { RootKey: AuditRegistry.RootKey }),
        new ConsoleDataRootFile(TenantAdminRegistry.EmailDomains, ConsoleEmailDomainStore.FileName, {}),
        new ConsoleDataRootFile(TenantAdminRegistry.Registration, ConsoleRegistration.FileName, {}),
        new ConsoleDataRootFile(TenantAdminRegistry.OwnerResetApplied, ConsoleOwnerResetFollower.FileName, {}),
    ]

    /** Whether the folder holds records the console wrote before its database (the delivery files do not count). */
    public static HoldsRecords(dataRoot: string): boolean
    {
        return TenantAdminDataRoot.Files.some(file => existsSync(join(dataRoot, file.FileName)))
    }
}

/** The database already holds records and the import was not forced. */
export class TenantAdminImportRefusedError extends Error
{
    private static readonly ErrorName = 'TenantAdminImportRefusedError'
    private static readonly MessagePrefix = 'The tenant admin database is not empty (it holds '
    private static readonly MessageSuffix = '); run with --force to import over it.'
    private static readonly ListSeparator = ', '

    public constructor(public readonly NonEmpty: readonly string[])
    {
        super(TenantAdminImportRefusedError.MessagePrefix + NonEmpty.join(TenantAdminImportRefusedError.ListSeparator) + TenantAdminImportRefusedError.MessageSuffix)
        this.name = TenantAdminImportRefusedError.ErrorName
    }
}

/** The completion record an import writes last: when it finished. */
export type TenantAdminImportState = { importedAt: string }

/** What one import wrote: rows per table, and what it left out on purpose. */
export class TenantAdminImportReport
{
    public readonly Counts = new Map<string, number>()
    public readonly Skipped: string[] = []

    public Count(table: string, n: number): void
    {
        this.Counts.set(table, (this.Counts.get(table) ?? 0) + n)
    }

    public ToJson(): { counts: Record<string, number>; skipped: string[] }
    {
        return { counts: Object.fromEntries([...this.Counts].sort(([a], [b]) => a.localeCompare(b))), skipped: [...this.Skipped] }
    }
}

/**
 * The one-time move of an in-hive tenant admin console's JSON data root into its Postgres database (A5 sub-task 4). It
 * only reads the data root (the files stay as the backup) and writes every record into the database under the same keys
 * and documents, plus the platform's last delivery (seed, verified images). Idempotent: a second, forced run writes the
 * same state. It refuses a database that already holds records unless forced. The writes run in one transaction (when
 * the session can transact, as Postgres does) and end with a completion record, so a failed import is never mistaken for
 * a finished one: the next start imports again (over whatever part of it a backend without transactions kept). Not imported, on purpose: the sessions
 * (everyone signs in again) and the OIDC client secrets (`tenant-admin-oidc/`: sealed in the pre-A5 file stores; a client
 * whose secret is missing rotates it and registers again at its next sign-in).
 *
 * A console needs no operator for this: at start, a database that holds none of these records over a data root that
 * still does is imported once (ImportIfPending), so an upgraded console keeps its environments.
 */
export class TenantAdminImport
{
    private static readonly SessionsSkipped = 'sessions: console and desktop sessions are not imported (everyone signs in again)'
    private static readonly SecretsSkipped = 'OIDC client secrets: rotated and registered again at the next sign-in'
    private static readonly ImportedLinePrefix = '[tenant-admin-import] imported the pre-A5 data root: '
    /** The key of the completion record. */
    public static readonly StateKey = 'pre-a5'

    public constructor(private readonly dataRoot: string, private readonly database: TenantAdminDatabase)
    {
    }

    /**
     * At start: when the data root holds pre-A5 records and the database no finished import (no completion record, and
     * none of those records unless an earlier import of them failed part way), imports them once (logged) and answers
     * the report; otherwise nothing (undefined).
     */
    public static async ImportIfPending(dataRoot: string, database: TenantAdminDatabase, log: (line: string) => void): Promise<TenantAdminImportReport | undefined>
    {
        if (!TenantAdminDataRoot.HoldsRecords(dataRoot))
        {
            return undefined
        }
        if (await TenantAdminImport.Finished(database))
        {
            return undefined
        }
        const report = await new TenantAdminImport(dataRoot, database).Run(true)
        log(TenantAdminImport.ImportedLinePrefix + JSON.stringify(report.ToJson()))
        return report
    }

    public async Run(force: boolean): Promise<TenantAdminImportReport>
    {
        if (!force)
        {
            const nonEmpty = await this.NonEmptyTables()
            if (nonEmpty.length > 0)
            {
                throw new TenantAdminImportRefusedError(nonEmpty)
            }
        }
        const session = this.database.Session
        const report = session.Transaction === undefined
            ? await this.Write(this.database)
            : await session.Transaction(tx => this.Write(TenantAdminDatabase.Over(tx)))
        report.Skipped.push(TenantAdminImport.SessionsSkipped, TenantAdminImport.SecretsSkipped)
        return report
    }

    /** Every record of the data root and the delivery, written over `database` (the import's transaction). */
    private async Write(database: TenantAdminDatabase): Promise<TenantAdminImportReport>
    {
        const report = new TenantAdminImportReport()
        for (const file of TenantAdminDataRoot.Files)
        {
            const records = await new FileRecordMap<unknown>(join(this.dataRoot, file.FileName), file.Options).Load()
            const map = await database.Map<unknown>(file.Registry)
            await map.Save(records, new Set(records.keys()))
            report.Count(map.Location, records.size)
        }
        await this.ImportDelivery(database, report)
        await (await TenantAdminImport.State(database)).Write({ importedAt: new Date().toISOString() })
        return report
    }

    /** Whether an import of a pre-A5 data root completed over `database`. */
    public static async Finished(database: TenantAdminDatabase): Promise<boolean>
    {
        return await (await TenantAdminImport.State(database)).Read() !== undefined
    }

    private static async State(database: TenantAdminDatabase): Promise<RecordSlot<TenantAdminImportState>>
    {
        return RecordSlot.Of(await database.Map<TenantAdminImportState>(TenantAdminRegistry.ImportState), TenantAdminImport.StateKey)
    }

    /** The tables of the console's own records that already hold rows (the delivery tables are refreshed at every start). */
    public async NonEmptyTables(): Promise<string[]>
    {
        const nonEmpty: string[] = []
        for (const file of TenantAdminDataRoot.Files)
        {
            const map = await this.database.Map(file.Registry)
            if (!await map.IsEmpty())
            {
                nonEmpty.push(map.Location)
            }
        }
        return nonEmpty
    }

    /** The platform's last delivery, stored as the console would store it at start (validated). */
    private async ImportDelivery(database: TenantAdminDatabase, report: TenantAdminImportReport): Promise<void>
    {
        if (existsSync(join(this.dataRoot, ConsoleDelivery.SeedFile)))
        {
            const seeds = await database.Map<unknown>(TenantAdminRegistry.DirectorySeed)
            await ConsoleDelivery.Seed(this.dataRoot, seeds)
            report.Count(seeds.Location, 1)
        }
        if (existsSync(join(this.dataRoot, ConsoleDelivery.VerifiedImagesFile)))
        {
            const images = await database.Map<unknown>(TenantAdminRegistry.VerifiedImages)
            await ConsoleDelivery.VerifiedImages(this.dataRoot, images)
            report.Count(images.Location, 1)
        }
    }
}
