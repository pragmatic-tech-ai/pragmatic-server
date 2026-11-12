import { randomUUID } from 'node:crypto'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import { AsyncMutex } from '../cypher/async-mutex.js'

/** Where the store reports a pending list it cannot read (listed as empty; the next write replaces it). */
export interface IPendingBackfillDiagnostics
{
    Unreadable(error: unknown): void
}

/** Reports an unreadable pending list as one warning on the server logger, by error name only. */
export class LoggerPendingBackfillDiagnostics implements IPendingBackfillDiagnostics
{
    private static readonly Line = 'pending ownership backfill list unreadable; listed as empty: '
    private static readonly UnknownName = 'UnknownError'

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public Unreadable(error: unknown): void
    {
        this.logger.Warn(LoggerPendingBackfillDiagnostics.Line + (error instanceof Error ? error.name : LoggerPendingBackfillDiagnostics.UnknownName))
    }
}

/** The stored pending list is not a list of concept names. */
class MalformedPendingBackfillError extends Error
{
    private static readonly ErrorName = 'MalformedPendingBackfillError'
    private static readonly Text = 'the pending backfill list is not a list of concept names'

    public constructor()
    {
        super(MalformedPendingBackfillError.Text)
        this.name = MalformedPendingBackfillError.ErrorName
    }
}

/**
 * The concepts whose ownership backfill is still owed (S4 Task 13, PR16): `graphs/pending-backfill.json`, a sorted list
 * of concept names. A delivery adds its newly owned concepts BEFORE its persist step, so a crash or a lost lease between
 * the persist and the backfill cannot lose them: whichever server opens the environment next resumes them. A concept
 * leaves the list once its backfill committed, or when an open finds the catalog it launches does not own it (left by
 * a delivery whose persist step failed). Writes are atomic (temp file + rename, the temp removed on failure) and
 * serialized. An unreadable or malformed file lists as empty (reported, error name only) and the next write replaces
 * it: the list never blocks a delivery.
 */
export class PendingBackfillStore
{
    public static readonly FileName = 'pending-backfill.json'
    private static readonly TempPrefix = '.pending-backfill-'
    private static readonly TempSuffix = '.tmp'

    private readonly mutex = new AsyncMutex()

    public constructor(private readonly storage: IStorage, private readonly diagnostics: IPendingBackfillDiagnostics = new LoggerPendingBackfillDiagnostics())
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

    /** Keeps only the owed concepts `owned` holds (the catalog an open launches). */
    public Retain(owned: ReadonlySet<string>): Promise<void>
    {
        return this.mutex.Run(async () =>
        {
            const pending = await this.List()
            const kept = pending.filter(concept => owned.has(concept))
            if (kept.length !== pending.length) await this.Write(kept)
        })
    }

    /** The owed concepts; empty when none were ever recorded or the file cannot be read (reported). */
    public async List(): Promise<string[]>
    {
        try
        {
            if (!(await this.storage.Exists(PendingBackfillStore.FileName)))
            {
                return []
            }
            const concepts: unknown = JSON.parse(await this.storage.ReadText(PendingBackfillStore.FileName))
            if (!Array.isArray(concepts) || !concepts.every(concept => typeof concept === 'string')) throw new MalformedPendingBackfillError()
            return concepts as string[]
        }
        catch (error)
        {
            this.diagnostics.Unreadable(error)
            return []
        }
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
