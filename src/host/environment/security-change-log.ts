import { randomUUID } from 'node:crypto'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import { AsyncMutex } from '../cypher/async-mutex.js'

/** Where the change log reports what it never throws: a malformed file and an append that did not land. */
export interface ISecurityChangeLogDiagnostics
{
    Unreadable(error: unknown): void
    AppendFailed(error: unknown): void
}

/** Reports each event as one line on the server logger, by error name only (messages can carry paths). */
export class LoggerSecurityChangeLogDiagnostics implements ISecurityChangeLogDiagnostics
{
    private static readonly UnreadableLine = 'security change log unreadable; listed as empty: '
    private static readonly AppendLine = 'security change log entry not written: '
    private static readonly UnknownName = 'UnknownError'

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public Unreadable(error: unknown): void
    {
        this.logger.Warn(LoggerSecurityChangeLogDiagnostics.UnreadableLine + LoggerSecurityChangeLogDiagnostics.NameOf(error))
    }

    public AppendFailed(error: unknown): void
    {
        this.logger.Error(LoggerSecurityChangeLogDiagnostics.AppendLine + LoggerSecurityChangeLogDiagnostics.NameOf(error))
    }

    private static NameOf(error: unknown): string
    {
        return error instanceof Error ? error.name : LoggerSecurityChangeLogDiagnostics.UnknownName
    }
}

/** The stored log is not a list of entries. */
class MalformedSecurityChangeLogError extends Error
{
    private static readonly ErrorName = 'MalformedSecurityChangeLogError'
    private static readonly Text = 'the security change log is not a list'

    public constructor()
    {
        super(MalformedSecurityChangeLogError.Text)
        this.name = MalformedSecurityChangeLogError.ErrorName
    }
}

/**
 * The environment's security change log (S4 Task 13, PR14): `graphs/security-changes.json`, the security changes of
 * the last `MaxEntries` deploys and promotes that changed any, newest first, for tenant-admin's change log. `Append`
 * is called with a non-empty diff only; it rewrites the file atomically (temp file + rename, the temp removed when the
 * rename fails), appends one at a time, and drops the oldest entries beyond `MaxEntries`. The log is a record, never
 * a gate: a malformed file lists as empty (reported), and an append that fails (including a storage read error,
 * which never overwrites the history) is reported, not thrown (a deploy whose setting is already pruned is not failed
 * by its log). Survives a restart.
 */
export class SecurityChangeLog
{
    public static readonly FileName = 'security-changes.json'
    public static readonly MaxEntries = 50
    private static readonly TempPrefix = '.security-changes-'
    private static readonly TempSuffix = '.tmp'

    private readonly mutex = new AsyncMutex()

    public constructor(private readonly storage: IStorage, private readonly diagnostics: ISecurityChangeLogDiagnostics = new LoggerSecurityChangeLogDiagnostics())
    {
    }

    /** Prepends `entry`; a failure is reported (AppendFailed), never thrown. */
    public Append(entry: SecurityChangesDto): Promise<void>
    {
        return this.mutex.Run(async () =>
        {
            try
            {
                await this.Write([entry, ...(await this.List())].slice(0, SecurityChangeLog.MaxEntries))
            }
            catch (error)
            {
                this.diagnostics.AppendFailed(error)
            }
        })
    }

    /**
     * The logged changes, newest first; empty when nothing was ever logged or the stored content is malformed
     * (reported). A storage read error propagates, so `Append` reports it instead of overwriting the history.
     */
    public async List(): Promise<SecurityChangesDto[]>
    {
        if (!(await this.storage.Exists(SecurityChangeLog.FileName)))
        {
            return []
        }
        const text = await this.storage.ReadText(SecurityChangeLog.FileName)
        try
        {
            const entries: unknown = JSON.parse(text)
            if (!Array.isArray(entries)) throw new MalformedSecurityChangeLogError()
            return entries as SecurityChangesDto[]
        }
        catch (error)
        {
            this.diagnostics.Unreadable(error)
            return []
        }
    }

    private async Write(entries: readonly SecurityChangesDto[]): Promise<void>
    {
        const temp = SecurityChangeLog.TempPrefix + randomUUID() + SecurityChangeLog.TempSuffix
        try
        {
            await this.storage.WriteText(temp, JSON.stringify(entries, null, 2))
            await this.storage.Rename(temp, SecurityChangeLog.FileName)
        }
        catch (error)
        {
            await this.storage.Delete(temp).catch(() => undefined)
            throw error
        }
    }
}
