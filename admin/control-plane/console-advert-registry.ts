import { JsonRecordStore } from './json-record-store.js'

/** The one console advert a tenant's in-hive console last reported; the record id is the tenant id. */
export type ConsoleAdvertRecord = {
    id: string
    tenantId: string
    hiveId: string
    consoleUrl: string
    fingerprints: string[]
    emailDomains: string[]
    firstReportedAt: string
    reportedAt: string
}

export interface IConsoleAdvertLookup
{
    ForTenant(tenantId: string): ConsoleAdvertRecord | undefined
    /** Live records, not cloned: callers must not mutate them (discovery reads every advert per request). */
    All(): readonly Readonly<ConsoleAdvertRecord>[]
    HasFingerprint(tenantId: string, fingerprint: string): boolean
}

export class ConsoleAdvertRegistry extends JsonRecordStore<ConsoleAdvertRecord> implements IConsoleAdvertLookup
{
    public static readonly FileName = 'console-adverts.json'
    public static readonly StaleAfterMs = 24 * 60 * 60 * 1000
    private static readonly RootKey = 'adverts'

    private readonly fingerprintSets = new Map<string, ReadonlySet<string>>()

    public constructor(filePath: string)
    {
        super(filePath, ConsoleAdvertRegistry.RootKey)
    }

    public override async Load(): Promise<void>
    {
        await super.Load()
        this.fingerprintSets.clear()
        for (const record of this.Values())
        {
            this.fingerprintSets.set(record.tenantId, new Set(record.fingerprints))
        }
    }

    public ForTenant(tenantId: string): ConsoleAdvertRecord | undefined
    {
        return this.Get(tenantId)
    }

    public All(): readonly Readonly<ConsoleAdvertRecord>[]
    {
        return [...this.Values()]
    }

    public HasFingerprint(tenantId: string, fingerprint: string): boolean
    {
        return this.fingerprintSets.get(tenantId)?.has(fingerprint) ?? false
    }

    /** Replaces the tenant's advert; keeps firstReportedAt when the previous advert came from the same hive, else firstReportedAt = reportedAt. */
    public async Report(advert: Omit<ConsoleAdvertRecord, 'id' | 'firstReportedAt'>): Promise<ConsoleAdvertRecord>
    {
        const previous = this.Get(advert.tenantId)
        const firstReportedAt = previous !== undefined && previous.hiveId === advert.hiveId ? previous.firstReportedAt : advert.reportedAt
        const record: ConsoleAdvertRecord = { ...advert, id: advert.tenantId, firstReportedAt }
        this.Stage(record)
        this.fingerprintSets.set(record.tenantId, new Set(record.fingerprints))
        await this.Flush()
        return structuredClone(record)
    }

    public async ForgetHive(hiveId: string): Promise<void>
    {
        const tenantIds = [...this.Values()].filter(r => r.hiveId === hiveId).map(r => r.tenantId)
        await this.Forget(tenantIds)
    }

    public async ForgetTenant(tenantId: string): Promise<void>
    {
        await this.Forget([tenantId])
    }

    /** True when more than StaleAfterMs has passed since the advert was last reported. */
    public static IsStale(record: Readonly<ConsoleAdvertRecord>, now: Date): boolean
    {
        return now.getTime() - Date.parse(record.reportedAt) > ConsoleAdvertRegistry.StaleAfterMs
    }

    private async Forget(tenantIds: readonly string[]): Promise<void>
    {
        let removed = false
        for (const tenantId of tenantIds)
        {
            this.fingerprintSets.delete(tenantId)
            removed = this.Unstage(tenantId) || removed
        }
        if (removed)
        {
            await this.Flush()
        }
    }
}
