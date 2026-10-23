import { JsonRecordStore } from '../json-record-store.js'

export type TenantAdminClientRecord = {
    id: string
    tenantId: string
    clientId: string
    secretRef: string
    rotatedAt: string
}

export class TenantAdminClientRegistry extends JsonRecordStore<TenantAdminClientRecord>
{
    private static readonly RootKey = 'tenant-admin-clients'

    public constructor(filePath: string)
    {
        super(filePath, TenantAdminClientRegistry.RootKey)
    }
}
