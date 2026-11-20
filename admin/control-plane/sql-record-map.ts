import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlRecordStore, SqlRecordStoreMigrations } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { IRecordMap } from './record-map.js'

/** One stored row of a SqlRecordMap: the record under its key (the key is the row id). */
export type SqlRecordMapRow<T> = { id: string; record: T }

/**
 * The Postgres form of a record map: one `records_<registry>` table (SqlRecordStore), one row per key holding
 * `{ id: key, record }`. Save writes only the changed keys (an upsert, or a delete for a key no longer in the map), each
 * durable when Save resolves; a batch is not one transaction, so a crash mid-batch leaves every row whole.
 */
export class SqlRecordMap<T> implements IRecordMap<T>
{
    private constructor(private readonly store: SqlRecordStore<SqlRecordMapRow<T>>, public readonly Location: string)
    {
    }

    /** Opens (and migrates) the table of `registry`, a lower-case SQL identifier such as `hives`. */
    public static async Open<T>(session: ISqlSession, registry: string): Promise<SqlRecordMap<T>>
    {
        const store = await SqlRecordStore.Open<SqlRecordMapRow<T>>(session, registry)
        return new SqlRecordMap<T>(store, new SqlRecordStoreMigrations(registry).Table)
    }

    public async Load(): Promise<ReadonlyMap<string, T>>
    {
        return new Map((await this.store.List()).map(row => [row.id, row.record]))
    }

    public async Save(all: ReadonlyMap<string, T>, changed: ReadonlySet<string>): Promise<void>
    {
        for (const key of changed)
        {
            const record = all.get(key)
            if (record === undefined)
            {
                await this.store.Delete(key)
            }
            else
            {
                await this.store.Put({ id: key, record })
            }
        }
    }

    /** Whether the table holds any row (the importer refuses to write over a database that is not empty). */
    public async IsEmpty(): Promise<boolean>
    {
        return (await this.store.List()).length === 0
    }
}
