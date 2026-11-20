import { JsonRecordStore } from '../json-record-store.js'
import type { IRecordMap } from '../record-map.js'

export type TenantAdminClientRecord = {
    id: string
    tenantId: string
    clientId: string
    secretRef: string
    rotatedAt: string
}

export class TenantAdminClientRegistry extends JsonRecordStore<TenantAdminClientRecord>
{
    public static readonly RootKey = 'tenant-admin-clients'

    public constructor(location: string | IRecordMap<TenantAdminClientRecord>)
    {
        super(location, TenantAdminClientRegistry.RootKey)
    }
}
