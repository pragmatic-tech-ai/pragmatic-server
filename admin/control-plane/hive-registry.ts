import { JsonRecordStore } from './json-record-store.js'
import type { IRecordMap } from './record-map.js'
import type { HiveRecord } from './platform-records.js'

export class HiveRegistry extends JsonRecordStore<HiveRecord>
{
    public static readonly RootKey = 'hives'

    public constructor(location: string | IRecordMap<HiveRecord>)
    {
        super(location, HiveRegistry.RootKey)
    }
}
