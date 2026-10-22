import { JsonRecordStore } from './json-record-store.js'
import type { TenantRecord } from './platform-records.js'

export class TenantRegistry extends JsonRecordStore<TenantRecord>
{
    private static readonly RootKey = 'tenants'

    public constructor(filePath: string)
    {
        super(filePath, TenantRegistry.RootKey)
    }
}
