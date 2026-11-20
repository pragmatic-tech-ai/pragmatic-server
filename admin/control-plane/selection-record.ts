import { JsonRecordStore } from './json-record-store.js'
import type { IRecordMap } from './record-map.js'

export type SelectionRecord = {
    id: string
    hiveId: string
    targetVersion: string
    selectedAt: string
}

export class SelectionRegistry extends JsonRecordStore<SelectionRecord>
{
    private static readonly RootKey = 'selections'

    public constructor(location: string | IRecordMap<SelectionRecord>)
    {
        super(location, SelectionRegistry.RootKey)
    }
}
