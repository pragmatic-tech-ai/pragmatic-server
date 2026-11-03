import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A realm to reopen at startup: its tenant id and display name. */
export type CatalogEntry = { tenantId: string; displayName: string };

/**
 * The IdP's durable list of realms (tenant id -> display name), kept beside the realm folders so a restarted IdP reopens
 * every realm the control plane created instead of only those named in PRAGMATIC_IDP_TENANTS. Realm folders that predate
 * the catalog are discovered too (their display name falls back to the tenant id).
 */
export class IdpRealmCatalog
{
    private static readonly FileName = 'realm-catalog.json';
    private static readonly Encoding = 'utf8';
    private static readonly TmpSuffix = '.tmp';
    private static readonly NotFound = 'ENOENT';
    private static readonly UnreadableMessage = 'IdpRealmCatalog: cannot read the realm catalog at ';
    private static readonly ReservedPrefix = '_';

    private readonly names = new Map<string, string>();
    private writes: Promise<void> = Promise.resolve();

    private constructor(private readonly realmsDir: string, private readonly file: string)
    {
    }

    /** The catalog for `realmsDir` (the folder holding one sub-folder per realm). Throws when the catalog file is unreadable. */
    public static async Open(realmsDir: string): Promise<IdpRealmCatalog>
    {
        const catalog = new IdpRealmCatalog(realmsDir, join(realmsDir, IdpRealmCatalog.FileName));
        await catalog.Load();
        return catalog;
    }

    /** Every realm to reopen: catalogued ones, then realm folders not yet in the catalog (display name = tenant id). */
    public Entries(): CatalogEntry[]
    {
        const entries: CatalogEntry[] = [...this.names].map(([tenantId, displayName]) => ({ tenantId, displayName }));
        for (const tenantId of this.RealmFolders())
        {
            if (!this.names.has(tenantId))
            {
                entries.push({ tenantId, displayName: tenantId });
            }
        }
        return entries;
    }

    /** Records a realm (idempotent; a changed display name replaces the old one). */
    public Record(tenantId: string, displayName: string): Promise<void>
    {
        if (this.names.get(tenantId) === displayName)
        {
            return Promise.resolve();
        }
        this.names.set(tenantId, displayName);
        const run = this.writes.then(async () =>
        {
            // Realm stores create their folders lazily, so the realms folder may not exist yet on the first record.
            await mkdir(this.realmsDir, { recursive: true });
            const tmp = this.file + IdpRealmCatalog.TmpSuffix;
            await writeFile(tmp, JSON.stringify(Object.fromEntries(this.names)), IdpRealmCatalog.Encoding);
            await rename(tmp, this.file);
        });
        this.writes = run.catch(() => undefined);
        return run;
    }

    private async Load(): Promise<void>
    {
        let parsed: unknown;
        try
        {
            parsed = JSON.parse(await readFile(this.file, IdpRealmCatalog.Encoding));
        }
        catch (e)
        {
            if ((e as NodeJS.ErrnoException).code === IdpRealmCatalog.NotFound)
            {
                return;
            }
            throw new Error(IdpRealmCatalog.UnreadableMessage + this.file);
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        {
            throw new Error(IdpRealmCatalog.UnreadableMessage + this.file);
        }
        for (const [tenantId, displayName] of Object.entries(parsed as Record<string, unknown>))
        {
            if (typeof displayName === 'string')
            {
                this.names.set(tenantId, displayName);
            }
        }
    }

    private RealmFolders(): string[]
    {
        if (!existsSync(this.realmsDir))
        {
            return [];
        }
        return readdirSync(this.realmsDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith(IdpRealmCatalog.ReservedPrefix))
            .map(d => d.name);
    }
}
