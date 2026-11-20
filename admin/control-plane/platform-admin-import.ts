import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { FileAuditSink, FileIdentityStores } from '@pragmatic-tech-ai/pragmatic-identity-store'
import type { IdentityStoreSet } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlAuditStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { AuditEntry, type IAuditRepository } from '@pragmatic-tech-ai/pragmatic-app-host'
import { FileRecordMap, type FileRecordMapOptions } from './record-map.js'
import { PlatformAdminRegistry, type PlatformAdminDatabase } from './platform-admin-database.js'
import { SqlSignatureStore } from './sql-signature-store.js'
import { OperatorIdentity } from './operator-identity.js'
import type { AuditRecord } from './audit-record.js'
import { AuditRegistry } from './audit-record.js'
import { ClientRegistry } from './client-registry.js'
import { TenantRegistry } from './tenant-registry.js'
import { HiveRegistry } from './hive-registry.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { IdpRegistry } from './idp-registry.js'
import { ManifestRegistry } from './manifest-record.js'
import { GatingRegistry } from './gating-record.js'
import { SelectionRegistry } from './selection-record.js'
import { HiveObservationRegistry } from './hive-observation-record.js'
import { RolloutRegistrationRegistry } from './rollout-registration-record.js'
import { ReleasePolicyRegistry } from './release-policy-record.js'
import { AdoptionLedgerRegistry } from './adoption-ledger-record.js'
import { TenantAdminClientRegistry } from './tenant-auth/tenant-admin-client-record.js'
import { TenantAccountIndex } from './tenant-account-index.js'
import { ConsoleAdvertRegistry } from './console-advert-registry.js'
import { ConsoleDomainApprovals } from './console-domain-approvals.js'
import { ConsoleOwnerResets } from './console-owner-resets.js'
import { SealedSecretStore } from './sealed-secret-store.js'

/** One registry file of the data root and the table it goes to. */
class DataRootFile
{
    public constructor(public readonly Registry: PlatformAdminRegistry, public readonly FileName: string, public readonly Options: FileRecordMapOptions)
    {
    }
}

/**
 * The platform admin console's JSON data root as the console wrote it before A5 (the layout on frontdoor's `padmin-data`
 * volume): one `{ <root>: { <key>: record } }` file per registry (the owner resets and signatures are bare maps), the
 * operator audit in `audit.json` and the operator identity stores under `identity/`. Mirrored from the code that wrote it.
 */
export class PlatformAdminDataRoot
{
    public static readonly AuditFile = 'audit.json'
    public static readonly SignaturesFile = 'signatures.json'
    public static readonly IdentityDir = 'identity'
    public static readonly Files: readonly DataRootFile[] = [
        new DataRootFile(PlatformAdminRegistry.Clients, 'clients.json', { RootKey: ClientRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.Tenants, 'tenants.json', { RootKey: TenantRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.Hives, 'hives.json', { RootKey: HiveRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.Environments, 'registry.json', { RootKey: EnvironmentRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.Idps, 'idps.json', { RootKey: IdpRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.Manifests, 'manifests.json', { RootKey: ManifestRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.Gating, 'gating.json', { RootKey: GatingRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.Selections, 'selections.json', { RootKey: SelectionRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.HiveObservations, 'hive-observations.json', { RootKey: HiveObservationRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.RolloutRegistrations, 'rollout-registrations.json', { RootKey: RolloutRegistrationRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.ReleasePolicies, 'release-policies.json', { RootKey: ReleasePolicyRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.AdoptionLedger, 'adoption-ledger.json', { RootKey: AdoptionLedgerRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.DesktopAudit, 'tenant-desktop-audit.json', { RootKey: AuditRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.GraphAudit, 'tenant-graph-audit.json', { RootKey: AuditRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.TenantAdminClients, 'tenant-admin-clients.json', { RootKey: TenantAdminClientRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.TenantAccounts, 'tenant-accounts.json', { RootKey: TenantAccountIndex.RootKey }),
        new DataRootFile(PlatformAdminRegistry.ConsoleAdverts, ConsoleAdvertRegistry.FileName, { RootKey: ConsoleAdvertRegistry.RootKey }),
        new DataRootFile(PlatformAdminRegistry.ConsoleDomainApprovals, ConsoleDomainApprovals.FileName, { RootKey: ConsoleDomainApprovals.RootKey }),
        new DataRootFile(PlatformAdminRegistry.ConsoleOwnerResets, ConsoleOwnerResets.FileName, {}),
        new DataRootFile(PlatformAdminRegistry.SealedSecrets, SealedSecretStore.FileName, { RootKey: SealedSecretStore.RootKey, RequireRoot: true }),
    ]
    private static readonly ClientsFile = 'clients.json'

    /** Whether the folder holds records from before the database (a registry file or the operator identity). */
    public static HoldsRecords(dataRoot: string): boolean
    {
        return existsSync(join(dataRoot, PlatformAdminDataRoot.ClientsFile)) || existsSync(join(dataRoot, PlatformAdminDataRoot.IdentityDir))
    }
}

/** The database already holds records and the import was not forced. */
export class PlatformAdminImportRefusedError extends Error
{
    private static readonly ErrorName = 'PlatformAdminImportRefusedError'
    private static readonly MessagePrefix = 'The platform admin database is not empty (it holds '
    private static readonly MessageSuffix = '); run with --force to import over it.'

    public constructor(public readonly NonEmpty: readonly string[])
    {
        super(PlatformAdminImportRefusedError.MessagePrefix + NonEmpty.join(', ') + PlatformAdminImportRefusedError.MessageSuffix)
        this.name = PlatformAdminImportRefusedError.ErrorName
    }
}

/** The data root still holds records the (empty) database lacks: the console refuses to start as an empty platform. */
export class PlatformAdminImportPendingError extends Error
{
    private static readonly ErrorName = 'PlatformAdminImportPendingError'
    private static readonly MessagePrefix = 'The platform admin database is empty but the data root holds records from before it: run bin/pragmatic-admin-import.js --data-root '
    private static readonly MessageSuffix = ' first (starting now would begin an empty platform beside them).'

    public constructor(dataRoot: string)
    {
        super(PlatformAdminImportPendingError.MessagePrefix + dataRoot + PlatformAdminImportPendingError.MessageSuffix)
        this.name = PlatformAdminImportPendingError.ErrorName
    }
}

/** What one import wrote: rows per table, and what it left out on purpose. */
export class PlatformAdminImportReport
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
 * The one-time move of the platform admin console's JSON data root into its Postgres database (A5 sub-task 4). It only
 * reads the data root (the files stay as the backup) and writes every record into the database: the registries row by
 * row (same keys, same documents), the operator audit into the activity trail (same entry ids), the signatures, the sealed
 * secrets (still sealed, byte for byte) and the operator identity (accounts, their password secrets re-sealed under the
 * same master key, grants, the IdP directory snapshot, the identity audit). Idempotent: a second, forced run writes the
 * same state. It refuses a database that already holds records unless forced. Not imported, on purpose: sessions
 * (operators sign in again), the co-hosted tenant plane's own files (they move with the tenant admin console), keys and
 * public material (they stay files).
 */
export class PlatformAdminImport
{
    private static readonly UniqueViolation = '23505'
    private static readonly AuditTable = 'app_host_audit'
    private static readonly IdentityAccountsTable = 'identity.accounts'
    private static readonly IdentityGrantsTable = 'identity.role_grants'
    private static readonly IdentitySecretsTable = 'identity.secrets'
    private static readonly IdentityDirectoryTable = 'identity.idp_directory'
    private static readonly IdentityAuditTable = 'identity.audit'
    private static readonly SessionsSkipped = 'sessions: operator and tenant sessions are not imported (operators sign in again)'
    private static readonly TokensSkippedPrefix = 'service tokens of the operator realm (hashed, cannot be moved; reissue them): '
    private static readonly SignaturesRegistry = PlatformAdminRegistry.Signatures
    private static readonly IdentityCopyPrefix = 'pragmatic-admin-import-identity-'

    public constructor(private readonly dataRoot: string, private readonly database: PlatformAdminDatabase, private readonly masterKey: Buffer)
    {
    }

    /** Refuses (PlatformAdminImportPendingError) a start over an empty database while the data root holds records. */
    public static async RequireImported(dataRoot: string, database: PlatformAdminDatabase): Promise<void>
    {
        if (!PlatformAdminDataRoot.HoldsRecords(dataRoot))
        {
            return
        }
        const clients = await database.Map(PlatformAdminRegistry.Clients)
        const accounts = await (await OperatorIdentity.AccountStore(database.Session)).ListAccounts(OperatorIdentity.Realm())
        if (await clients.IsEmpty() && accounts.length === 0)
        {
            throw new PlatformAdminImportPendingError(dataRoot)
        }
    }

    public async Run(force: boolean): Promise<PlatformAdminImportReport>
    {
        const target = await OperatorIdentity.OpenStores(this.database.Session, this.masterKey)
        const audit = await this.database.Audit()
        if (!force)
        {
            const nonEmpty = await this.NonEmptyTables(target, audit)
            if (nonEmpty.length > 0)
            {
                throw new PlatformAdminImportRefusedError(nonEmpty)
            }
        }
        const report = new PlatformAdminImportReport()
        for (const file of PlatformAdminDataRoot.Files)
        {
            await this.ImportFile(file, report)
        }
        await this.ImportSignatures(report)
        await this.ImportAudit(audit, report)
        await this.ImportIdentity(target, report)
        report.Skipped.push(PlatformAdminImport.SessionsSkipped)
        return report
    }

    /** The tables that already hold rows. */
    private async NonEmptyTables(target: IdentityStoreSet, audit: IAuditRepository): Promise<string[]>
    {
        const nonEmpty: string[] = []
        for (const registry of Object.values(PlatformAdminRegistry))
        {
            const map = await this.database.Map(registry)
            if (!await map.IsEmpty())
            {
                nonEmpty.push(map.Location)
            }
        }
        if ((await audit.Recent(1)).length > 0)
        {
            nonEmpty.push(PlatformAdminImport.AuditTable)
        }
        if ((await target.Accounts.ListAccounts(OperatorIdentity.Realm())).length > 0)
        {
            nonEmpty.push(PlatformAdminImport.IdentityAccountsTable)
        }
        return nonEmpty
    }

    private async ImportFile(file: DataRootFile, report: PlatformAdminImportReport): Promise<void>
    {
        const records = await new FileRecordMap<unknown>(join(this.dataRoot, file.FileName), file.Options).Load()
        const map = await this.database.Map<unknown>(file.Registry)
        await map.Save(records, new Set(records.keys()))
        report.Count(map.Location, records.size)
    }

    private async ImportSignatures(report: PlatformAdminImportReport): Promise<void>
    {
        const entries = await new FileRecordMap<string | Record<string, string>>(join(this.dataRoot, PlatformAdminDataRoot.SignaturesFile)).Load()
        const rows = new Map([...entries].map(([digest, entry]) => [digest, SqlSignatureStore.RecordOf(entry)]))
        const map = await this.database.Map<Record<string, string>>(PlatformAdminImport.SignaturesRegistry)
        await map.Save(rows, new Set(rows.keys()))
        report.Count(map.Location, rows.size)
    }

    /** The operator audit, under the same entry ids (an id already in the trail is kept as it is). */
    private async ImportAudit(audit: IAuditRepository, report: PlatformAdminImportReport): Promise<void>
    {
        const records = await new FileRecordMap<AuditRecord>(join(this.dataRoot, PlatformAdminDataRoot.AuditFile), { RootKey: AuditRegistry.RootKey }).Load()
        let written = 0
        for (const [id, r] of records)
        {
            try
            {
                await audit.Append(new AuditEntry(id, r.actor, r.method, r.path, r.status, new Date(r.at), r.note))
                written++
            }
            catch (err)
            {
                if ((err as { code?: string }).code !== PlatformAdminImport.UniqueViolation)
                {
                    throw err
                }
            }
        }
        report.Count(PlatformAdminImport.AuditTable, written)
    }

    /** The operator realm's identity: accounts, their secrets, grants, the IdP directory snapshot and the identity audit. */
    private async ImportIdentity(target: IdentityStoreSet, report: PlatformAdminImportReport): Promise<void>
    {
        const P = PlatformAdminImport
        const identityRoot = join(this.dataRoot, PlatformAdminDataRoot.IdentityDir)
        if (!existsSync(identityRoot))
        {
            // A data root that never held an operator (the file stores would create their folder on open).
            return
        }
        // The file stores upgrade what they open (legacy realm ids, missing audit hashes): they read a private copy, so the
        // data root itself is never written.
        const copy = mkdtempSync(join(tmpdir(), P.IdentityCopyPrefix))
        try
        {
            cpSync(identityRoot, copy, { recursive: true })
            await this.ImportIdentityFrom(await FileIdentityStores.Open(new NodeFsStorage(copy), this.masterKey), target, report)
        }
        finally
        {
            rmSync(copy, { recursive: true, force: true })
        }
    }

    private async ImportIdentityFrom(source: IdentityStoreSet, target: IdentityStoreSet, report: PlatformAdminImportReport): Promise<void>
    {
        const P = PlatformAdminImport
        const realm = OperatorIdentity.Realm()
        const accounts = await source.Accounts.ListAccounts(realm)
        const secretRefs = new Set<string>([OperatorIdentity.BootstrapPasswordRef])
        const principals = new Set<string>([OperatorIdentity.BootstrapPrincipalId])
        let created = 0
        for (const account of accounts)
        {
            secretRefs.add(account.SecretRef)
            principals.add(account.PrincipalId)
            if (await target.Accounts.FindByPrincipalId(realm, account.PrincipalId) === null)
            {
                await target.Accounts.CreateAccount(realm, account.Email, account.PrincipalId, account.SecretRef)
                created++
            }
            if (account.Disabled)
            {
                await target.Accounts.Disable(realm, account.PrincipalId)
            }
        }
        report.Count(P.IdentityAccountsTable, created)
        let secrets = 0
        for (const ref of secretRefs)
        {
            const value = await source.Secrets.Get(ref)
            if (value !== null)
            {
                await target.Secrets.Put(ref, value)
                secrets++
            }
        }
        report.Count(P.IdentitySecretsTable, secrets)
        let grants = 0
        for (const principal of principals)
        {
            const present = new Set((await target.Grants.GrantsFor(principal, realm)).map(g => JSON.stringify(g)))
            for (const grant of await source.Grants.GrantsFor(principal, realm))
            {
                if (!present.has(JSON.stringify(grant)))
                {
                    await target.Grants.Save(grant)
                    grants++
                }
            }
        }
        report.Count(P.IdentityGrantsTable, grants)
        const directory = await source.IdpDirectory.Get(realm.Id)
        if (directory !== null)
        {
            await target.IdpDirectory.Save(realm.Id, directory)
            report.Count(P.IdentityDirectoryTable, 1)
        }
        await this.ImportIdentityAudit(source, target, report)
        const tokens = await source.Tokens.List(realm)
        if (tokens.length > 0)
        {
            report.Skipped.push(P.TokensSkippedPrefix + String(tokens.length))
        }
    }

    /** The identity audit chain of the operator realm, re-recorded in order (the chain is re-hashed), once: a target that
     *  already holds the realm's chain is left as it is. */
    private async ImportIdentityAudit(source: IdentityStoreSet, target: IdentityStoreSet, report: PlatformAdminImportReport): Promise<void>
    {
        const realmId = OperatorIdentity.Realm().Id
        if (!(source.Audit instanceof FileAuditSink) || !(target.Audit instanceof SqlAuditStore) || target.Audit.Records(realmId).length > 0)
        {
            return
        }
        const records = source.Audit.Records(realmId)
        for (const record of records)
        {
            await target.Audit.Record(record.Event)
        }
        report.Count(PlatformAdminImport.IdentityAuditTable, records.length)
    }
}
