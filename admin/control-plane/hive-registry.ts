import { JsonRecordStore } from './json-record-store.js'
import type { HiveRecord } from './platform-records.js'

export class HiveRegistry extends JsonRecordStore<HiveRecord>
{
    private static readonly RootKey = 'hives'

    public constructor(filePath: string)
    {
        super(filePath, HiveRegistry.RootKey)
    }
}
