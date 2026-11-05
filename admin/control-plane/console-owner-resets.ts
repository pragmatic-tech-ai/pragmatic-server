import { readFile } from 'node:fs/promises'
import { AtomicJsonFile, SerialRuns } from './atomic-json-file.js'
import type { IOwnerResetSource } from './console-advert-receiver.js'
import { OwnerResetTime } from './tenant-owner.js'

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
    private static readonly Utf8 = 'utf8'
    private static readonly NotFoundCode = 'ENOENT'
    private static readonly JsonIndent = 2
    private static readonly MalformedPrefix = 'Invalid Owner reset file (expected { [tenantId]: ISO time }): '

    private resets = new Map<string, string>()
    private readonly writes = new SerialRuns()

    public constructor(private readonly filePath: string, private readonly now: () => Date = () => new Date())
    {
    }

    /** A missing file is empty; a malformed one throws naming the file. Never writes. */
    public async Load(): Promise<void>
    {
        let text: string
        try
        {
            text = await readFile(this.filePath, ConsoleOwnerResets.Utf8)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code !== ConsoleOwnerResets.NotFoundCode)
            {
                throw err
            }
            this.resets = new Map()
            return
        }
        this.resets = ConsoleOwnerResets.Parse(text, this.filePath)
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
            await this.Commit(new Map(this.resets).set(tenantId, iso))
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
            await this.Commit(next)
        })
    }

    private Serialised<T>(change: () => Promise<T>): Promise<T>
    {
        return this.writes.Run(change)
    }

    private async Commit(next: Map<string, string>): Promise<void>
    {
        await AtomicJsonFile.Write(this.filePath, Object.fromEntries(next), ConsoleOwnerResets.JsonIndent)
        this.resets = next
    }

    private static Parse(text: string, filePath: string): Map<string, string>
    {
        let body: unknown
        try
        {
            body = JSON.parse(text)
        }
        catch
        {
            throw new Error(ConsoleOwnerResets.MalformedPrefix + filePath)
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body))
        {
            throw new Error(ConsoleOwnerResets.MalformedPrefix + filePath)
        }
        const entries = Object.entries(body as Record<string, unknown>)
        if (!entries.every(([, v]) => OwnerResetTime.IsWellFormed(v)))
        {
            throw new Error(ConsoleOwnerResets.MalformedPrefix + filePath)
        }
        return new Map(entries as Array<[string, string]>)
    }
}
