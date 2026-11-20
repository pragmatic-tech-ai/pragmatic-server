import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Realm, RealmKind } from '@pragmatic-tech-ai/pragmatic-identity';
import { FileIdentityStores } from '@pragmatic-tech-ai/pragmatic-identity-store';
import { SqlRecordStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node';
import type { TenantIdpDatabase, TenantIdpStores } from './tenant-idp-database.js';

/** What one import moved. */
export class TenantIdpImportReport
{
    public constructor(public readonly Realms: number, public readonly Accounts: number, public readonly Clients: number)
    {
        Object.freeze(this);
    }

    public static readonly Nothing = new TenantIdpImportReport(0, 0, 0);
}

/** The completion record of the import (written last, so a part-failed import is retried at the next start). */
type ImportState = { id: string; importedAt: string; realms: number; accounts: number; clients: number };

/** One client row of the pre-A5 `clients.json`. */
type ClientRow = { clientId: string; tenantId: string; redirectUris: string[]; secretHash: string };

/**
 * Moves the pre-A5 file data of the realm sign-in service into its database, once (dev data only: no live service ran
 * the file layout, see the plan's Ledger): the realm catalogue (`realms/realm-catalog.json`, plus realm folders the
 * catalogue predates), each realm's local accounts (`realms/<realm>/`, the file identity stores sealed under the same
 * master key; password hashes re-sealed into the realm's SQL secrets, the same references), display names
 * (`idp-profiles.json`) and credential-change stamps (`idp-credentials-changed.json`), and the clients (`clients.json`,
 * secret hashes as they are). Sessions, codes and SSO sessions are not moved: people sign in again. The data folder is
 * never written (the file stores are opened over a private copy, since they upgrade what they open).
 */
export class TenantIdpImport
{
    private static readonly StateRegistry = 'tenant_idp_import';
    private static readonly StateId = 'pre-a5';
    private static readonly RealmsDir = 'realms';
    private static readonly CatalogFile = 'realm-catalog.json';
    private static readonly ProfilesFile = 'idp-profiles.json';
    private static readonly CredentialsChangedFile = 'idp-credentials-changed.json';
    private static readonly ClientsFile = 'clients.json';
    private static readonly ReservedPrefix = '_';
    private static readonly TempPrefix = 'pragmatic-idp-import-';
    private static readonly Utf8 = 'utf8';
    private static readonly NoName = '';

    /** Imports when the data folder holds pre-A5 records and no import completed yet; the report says what moved. */
    public static async ImportIfPending(database: TenantIdpDatabase, dataRoot: string, masterKey: Buffer): Promise<TenantIdpImportReport>
    {
        const I = TenantIdpImport;
        const state = await SqlRecordStore.Open<ImportState>(database.Session, I.StateRegistry);
        if ((await state.Get(I.StateId)) !== undefined || !I.HoldsRecords(dataRoot))
        {
            return TenantIdpImportReport.Nothing;
        }
        const report = await I.Import(database, dataRoot, masterKey);
        await state.Put({ id: I.StateId, importedAt: new Date().toISOString(), realms: report.Realms, accounts: report.Accounts, clients: report.Clients });
        return report;
    }

    public static HoldsRecords(dataRoot: string): boolean
    {
        return TenantIdpImport.RealmFolders(join(dataRoot, TenantIdpImport.RealmsDir)).length > 0 || existsSync(join(dataRoot, TenantIdpImport.ClientsFile));
    }

    private static async Import(database: TenantIdpDatabase, dataRoot: string, masterKey: Buffer): Promise<TenantIdpImportReport>
    {
        const I = TenantIdpImport;
        const stores = await database.Stores();
        const names = I.ReadMap(join(dataRoot, I.RealmsDir, I.CatalogFile));
        const realmIds = new Set([...names.keys(), ...I.RealmFolders(join(dataRoot, I.RealmsDir))]);
        let accounts = 0;
        for (const realmId of realmIds)
        {
            await stores.Realms.Record(realmId, names.get(realmId) ?? realmId);
            const folder = join(dataRoot, I.RealmsDir, realmId);
            if (existsSync(folder))
            {
                accounts += await I.ImportRealm(database, stores, realmId, folder, masterKey);
            }
        }
        let clients = 0;
        const clientsFile = join(dataRoot, I.ClientsFile);
        if (existsSync(clientsFile))
        {
            for (const row of JSON.parse(readFileSync(clientsFile, I.Utf8)) as ClientRow[])
            {
                await stores.Clients.Restore(row.tenantId, row.clientId, row.redirectUris, row.secretHash);
                clients++;
            }
        }
        return new TenantIdpImportReport(realmIds.size, accounts, clients);
    }

    private static async ImportRealm(database: TenantIdpDatabase, stores: TenantIdpStores, realmId: string, folder: string, masterKey: Buffer): Promise<number>
    {
        const I = TenantIdpImport;
        const copy = mkdtempSync(join(tmpdir(), I.TempPrefix));
        try
        {
            cpSync(folder, copy, { recursive: true });
            const files = await FileIdentityStores.Open(new NodeFsStorage(copy), masterKey);
            const realm = new Realm(realmId, RealmKind.SelfHosted, realmId);
            const secrets = await database.RealmSecrets(realmId, masterKey);
            const profiles = I.ReadMap(join(copy, I.ProfilesFile));
            const changed = I.ReadMap(join(copy, I.CredentialsChangedFile));
            let count = 0;
            for (const account of await files.Accounts.ListAccounts(realm))
            {
                // Only an account created here gets its hash: one a part-failed import created earlier may have a newer password.
                if ((await stores.Accounts.FindByPrincipalId(realm, account.PrincipalId)) === null)
                {
                    const hash = await files.Secrets.Get(account.SecretRef);
                    if (hash !== null)
                    {
                        await secrets.Put(account.SecretRef, hash);
                    }
                    await stores.Accounts.CreateAccount(realm, account.Email, account.PrincipalId, account.SecretRef);
                    if (account.Disabled)
                    {
                        await stores.Accounts.Disable(realm, account.PrincipalId);
                    }
                    await stores.Profiles.PutName(realmId, account.PrincipalId, profiles.get(account.PrincipalId) ?? I.NoName);
                    const at = changed.get(account.PrincipalId);
                    if (at !== undefined && !Number.isNaN(new Date(at).getTime()))
                    {
                        await stores.Profiles.StampCredentialsChanged(realmId, account.PrincipalId, new Date(at));
                    }
                }
                count++;
            }
            return count;
        }
        finally
        {
            rmSync(copy, { recursive: true, force: true });
        }
    }

    /** A `{ key: string }` JSON file as a map; empty when absent. */
    private static ReadMap(file: string): Map<string, string>
    {
        if (!existsSync(file))
        {
            return new Map();
        }
        const parsed = JSON.parse(readFileSync(file, TenantIdpImport.Utf8)) as Record<string, unknown>;
        return new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    }

    private static RealmFolders(realmsDir: string): string[]
    {
        if (!existsSync(realmsDir))
        {
            return [];
        }
        return readdirSync(realmsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith(TenantIdpImport.ReservedPrefix))
            .map(entry => entry.name);
    }
}
