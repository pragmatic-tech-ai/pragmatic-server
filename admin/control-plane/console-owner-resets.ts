import { SerialRuns, FileRecordMap, RecordMapFormatError, type IRecordMap, OwnerResetTime } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { IOwnerResetSource } from './console-advert-receiver.js'

/** Where the console installer records an operator Owner reset (before it reaches the IdP) and forgets it with the tenant. */
export interface IOwnerResetRecorder
{
    /** Stores the reset time for the tenant and returns it. */
    Record(tenantId: string): Promise<string>
    Forget(tenantId: string): Promise<void>
}

/**
 * The control plane's record of the last operator Owner reset of each in-hive console's tenant, kept in
 * `<dataRoot>/console-owner-resets.json` (`{ [tenantId]: iso }`). The console reads its tenant's value from the advert answer
 * and ends the Owner's sessions once per value. A record is kept through console removal and hive delete (the console's data
 * volume, and with it its sessions, survives both, so a reinstall must still see the reset) and is forgotten only with the
 * tenant. Writes are serialised and atomic (unique temp file, then rename); memory changes only after a write succeeded.
 */
export class ConsoleOwnerResets implements IOwnerResetRecorder, IOwnerResetSource
{
    public static readonly FileName = 'console-owner-resets.json'
    private static readonly MalformedPrefix = 'Invalid Owner reset file (expected { [tenantId]: ISO time }): '

    private resets = new Map<string, string>()
    private readonly writes = new SerialRuns()
    private readonly map: IRecordMap<string>

    /** `location`: the `{ [tenantId]: iso }` file, or a record map (the platform admin console's Postgres table). */
    public constructor(location: string | IRecordMap<string>, private readonly now: () => Date = () => new Date())
    {
        this.map = typeof location === 'string' ? new FileRecordMap<string>(location) : location
    }

    /** A missing file is empty; a malformed one throws naming where the records live. Never writes. */
    public async Load(): Promise<void>
    {
        let stored: ReadonlyMap<string, string>
        try
        {
            stored = await this.map.Load()
        }
        catch (err)
        {
            if (err instanceof RecordMapFormatError)
            {
                throw new Error(ConsoleOwnerResets.MalformedPrefix + this.map.Location)
            }
            throw err
        }
        if (![...stored.values()].every(v => OwnerResetTime.IsWellFormed(v)))
        {
            throw new Error(ConsoleOwnerResets.MalformedPrefix + this.map.Location)
        }
        this.resets = new Map(stored)
    }

    /**
     * Stores and returns now() as an ISO time. A reset in the same millisecond as the tenant's previous one is recorded one
     * millisecond later, so every reset is a new value the console acts on.
     */
    public Record(tenantId: string): Promise<string>
    {
        return this.Serialised(async () =>
        {
            let at = this.now().getTime()
            const previous = this.resets.get(tenantId)
            if (previous !== undefined && Date.parse(previous) >= at)
            {
                at = Date.parse(previous) + 1
            }
            const iso = new Date(at).toISOString()
            await this.Commit(new Map(this.resets).set(tenantId, iso), tenantId)
            return iso
        })
    }

    public Of(tenantId: string): string | undefined
    {
        return this.resets.get(tenantId)
    }

    /** Drops the tenant's record (tenant delete); nothing is written when it has none. */
    public Forget(tenantId: string): Promise<void>
    {
        return this.Serialised(async () =>
        {
            if (!this.resets.has(tenantId))
            {
                return
            }
            const next = new Map(this.resets)
            next.delete(tenantId)
            await this.Commit(next, tenantId)
        })
    }

    private Serialised<T>(change: () => Promise<T>): Promise<T>
    {
        return this.writes.Run(change)
    }

    private async Commit(next: Map<string, string>, tenantId: string): Promise<void>
    {
        await this.map.Save(next, new Set([tenantId]))
        this.resets = next
    }
}
