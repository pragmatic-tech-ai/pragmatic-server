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

    public constructor(filePath: string)
    {
        super(filePath, HiveObservationRegistry.RootKey)
    }

    public async RecordSnapshot(hiveId: string, environments: HiveHealthDto[]): Promise<void>
    {
        await this.Put({ id: hiveId, hiveId, environments, reportedAt: new Date().toISOString() })
    }

    public LatestFor(hiveId: string): HiveHealthDto[]
    {
        return this.Get(hiveId)?.environments ?? []
    }
}
