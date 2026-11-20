import { JsonRecordStore } from './json-record-store.js'
import type { IRecordMap } from './record-map.js'
import type { TenantRecord } from './platform-records.js'

export class TenantRegistry extends JsonRecordStore<TenantRecord>
{
    private static readonly RootKey = 'tenants'

    public constructor(location: string | IRecordMap<TenantRecord>)
    {
        super(location, TenantRegistry.RootKey)
    }
}
