import { JsonRecordStore } from './json-record-store.js'
import type { IRecordMap } from './record-map.js'

export type GatingRecord = {
    id: string
    tenantId: string
    version: string
    gatedAt: string
}

export class GatingRegistry extends JsonRecordStore<GatingRecord>
{
    public static readonly RootKey = 'gating'

    public constructor(location: string | IRecordMap<GatingRecord>)
    {
        super(location, GatingRegistry.RootKey)
    }
}
