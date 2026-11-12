import { randomUUID } from 'node:crypto'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AsyncMutex } from '../cypher/async-mutex.js'

/**
 * The environment's security change log (S4 Task 13, PR14): `graphs/security-changes.json`, the security changes of
 * the last `MaxEntries` deploys and promotes that changed any, newest first, for tenant-admin's change log. `Append`
 * is called with a non-empty diff only; it rewrites the file atomically (temp file + rename), appends one at a time,
 * and drops the oldest entries beyond `MaxEntries`. Survives a restart (the graphs root is on storage the next lease
 * holder reaches).
 */
export class SecurityChangeLog
{
    public static readonly FileName = 'security-changes.json'
    public static readonly MaxEntries = 50
    private static readonly TempPrefix = '.security-changes-'
    private static readonly TempSuffix = '.tmp'

    private readonly mutex = new AsyncMutex()

    public constructor(private readonly storage: IStorage)
    {
    }

    public Append(entry: SecurityChangesDto): Promise<void>
    {
        return this.mutex.Run(async () =>
        {
            const entries = [entry, ...(await this.List())].slice(0, SecurityChangeLog.MaxEntries)
            const temp = SecurityChangeLog.TempPrefix + randomUUID() + SecurityChangeLog.TempSuffix
            await this.storage.WriteText(temp, JSON.stringify(entries, null, 2))
            await this.storage.Rename(temp, SecurityChangeLog.FileName)
        })
    }

    /** The logged changes, newest first; empty when nothing was ever logged. */
    public async List(): Promise<SecurityChangesDto[]>
    {
        if (!(await this.storage.Exists(SecurityChangeLog.FileName)))
        {
            return []
        }
        return JSON.parse(await this.storage.ReadText(SecurityChangeLog.FileName)) as SecurityChangesDto[]
    }
}
