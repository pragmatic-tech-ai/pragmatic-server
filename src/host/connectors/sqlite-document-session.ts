import type { DatabaseSync } from 'node:sqlite'
import type { IDocumentSession } from '@pragmatic-tech-ai/todl-connectors-host'

/** Prod document store: one schema-agnostic JSON-row table via node:sqlite (lazy-loaded). */
export class SqliteDocumentSession implements IDocumentSession
{
    private static readonly CreateTable =
        'CREATE TABLE IF NOT EXISTS instances (source TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (source, id))'
    private static readonly SelectBySource = 'SELECT data FROM instances WHERE source = ?'
    private static readonly UpsertRow =
        'INSERT INTO instances (source, id, data) VALUES (?, ?, ?) ON CONFLICT (source, id) DO UPDATE SET data = excluded.data'
    private static readonly DeleteRow = 'DELETE FROM instances WHERE source = ? AND id = ?'

    private static readonly SqliteUnavailable =
        'the built-in SQLite store requires Node >= 22.5 with node:sqlite available (on 22.5-23.x enable --experimental-sqlite, or upgrade to Node 24+)'

    private dbOpen: Promise<DatabaseSync> | undefined

    public constructor(private readonly dbFilePath: string)
    {
    }

    public async Find(collection: string, _filter: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>
    {
        const db = await this.Db()
        const rows = db.prepare(SqliteDocumentSession.SelectBySource).all(collection) as unknown as readonly { data: string }[]
        return rows.map(r => JSON.parse(r.data) as Record<string, unknown>)
    }

    public async Upsert(collection: string, idField: string, key: unknown, doc: Record<string, unknown>): Promise<void>
    {
        const db = await this.Db()
        db.prepare(SqliteDocumentSession.UpsertRow).run(collection, String(key), JSON.stringify({ ...doc, [idField]: key }))
    }

    public async Delete(collection: string, _idField: string, key: unknown): Promise<boolean>
    {
        const db = await this.Db()
        const result = db.prepare(SqliteDocumentSession.DeleteRow).run(collection, String(key))
        return Number(result.changes) > 0
    }

    public async Dispose(): Promise<void>
    {
        const open = this.dbOpen
        this.dbOpen = undefined
        if (open !== undefined)
        {
            (await open).close()
        }
    }

    private Db(): Promise<DatabaseSync>
    {
        if (this.dbOpen === undefined)
        {
            const opening = this.Open()
            this.dbOpen = opening
            opening.catch(() =>
            {
                if (this.dbOpen === opening)
                {
                    this.dbOpen = undefined
                }
            })
        }
        return this.dbOpen
    }

    private async Open(): Promise<DatabaseSync>
    {
        let sqlite: typeof import('node:sqlite')
        try
        {
            sqlite = await import('node:sqlite')
        }
        catch (cause)
        {
            throw new Error(SqliteDocumentSession.SqliteUnavailable, { cause })
        }
        const db = new sqlite.DatabaseSync(this.dbFilePath)
        db.exec(SqliteDocumentSession.CreateTable)
        return db
    }
}
