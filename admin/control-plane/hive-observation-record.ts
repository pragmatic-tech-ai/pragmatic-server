import { randomUUID } from 'node:crypto'
import { JsonRecordStore } from './json-record-store.js'
import type { HiveHealthDto } from './hive-health-producer.js'

export type HiveObservationRecord = {
    id: string
    hiveId: string
    environments: HiveHealthDto[]
    reportedAt: string
}

export class HiveObservationRegistry extends JsonRecordStore<HiveObservationRecord>
{
    private static readonly RootKey = 'hiveObservations'
    private static readonly MaxPerHive = 50

    public constructor(filePath: string)
    {
        super(filePath, HiveObservationRegistry.RootKey)
    }

    public async RecordSnapshot(hiveId: string, environments: HiveHealthDto[]): Promise<void>
    {
        await this.Put({ id: randomUUID(), hiveId, environments, reportedAt: new Date().toISOString() })
        const ascending = this.AscendingFor(hiveId)
        const excess = ascending.length - HiveObservationRegistry.MaxPerHive
        for (let i = 0; i < excess; i++)
        {
            await this.Remove((ascending[i]!).id)
        }
    }

    public LatestFor(hiveId: string): HiveHealthDto[]
    {
        return this.LatestRecord(hiveId)?.environments ?? []
    }

    public LatestRecord(hiveId: string): HiveObservationRecord | undefined
    {
        return this.AscendingFor(hiveId).at(-1)
    }

    public HistoryFor(hiveId: string, limit: number): readonly HiveObservationRecord[]
    {
        return this.AscendingFor(hiveId).reverse().slice(0, limit)
    }

    /** This hive's records oldest-first; ties keep insertion order (stable sort). */
    private AscendingFor(hiveId: string): HiveObservationRecord[]
    {
        return [...this.Values()]
            .filter(r => r.hiveId === hiveId)
            .sort((a, b) => a.reportedAt.localeCompare(b.reportedAt))
            .map(r => structuredClone(r))
    }
}
