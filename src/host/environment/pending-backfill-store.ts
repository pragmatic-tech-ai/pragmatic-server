import { randomUUID } from 'node:crypto'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { AsyncMutex } from '../cypher/async-mutex.js'

/**
 * The concepts whose ownership backfill is still owed (S4 Task 13, PR16): `graphs/pending-backfill.json`, a sorted list
 * of concept names. A delivery adds its newly owned concepts BEFORE its persist step, so a crash or a lost lease between
 * the persist and the backfill cannot lose them: whichever server opens the environment next resumes them. A concept
 * leaves the list once its backfill committed. Writes are atomic (temp file + rename, the temp removed on failure) and
 * serialized.
 */
export class PendingBackfillStore
{
    public static readonly FileName = 'pending-backfill.json'
    private static readonly TempPrefix = '.pending-backfill-'
    private static readonly TempSuffix = '.tmp'

    private readonly mutex = new AsyncMutex()

    public constructor(private readonly storage: IStorage)
    {
    }

    public Add(concepts: readonly string[]): Promise<void>
    {
        return this.mutex.Run(async () =>
        {
            const pending = new Set(await this.List())
            const size = pending.size
            for (const concept of concepts) pending.add(concept)
            if (pending.size !== size) await this.Write([...pending])
        })
    }

    public Remove(concepts: readonly string[]): Promise<void>
    {
        return this.mutex.Run(async () =>
        {
            const removed = new Set(concepts)
            const pending = await this.List()
            const kept = pending.filter(concept => !removed.has(concept))
            if (kept.length !== pending.length) await this.Write(kept)
        })
    }

    /** The owed concepts; empty when none were ever recorded. */
    public async List(): Promise<string[]>
    {
        if (!(await this.storage.Exists(PendingBackfillStore.FileName)))
        {
            return []
        }
        return JSON.parse(await this.storage.ReadText(PendingBackfillStore.FileName)) as string[]
    }

    private async Write(concepts: readonly string[]): Promise<void>
    {
        const temp = PendingBackfillStore.TempPrefix + randomUUID() + PendingBackfillStore.TempSuffix
        try
        {
            await this.storage.WriteText(temp, JSON.stringify([...concepts].sort()))
            await this.storage.Rename(temp, PendingBackfillStore.FileName)
        }
        catch (error)
        {
            await this.storage.Delete(temp).catch(() => undefined)
            throw error
        }
    }
}
