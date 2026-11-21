import { JsonRecordStore, type IRecordMap, type TenantRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

export class TenantRegistry extends JsonRecordStore<TenantRecord>
{
    public static readonly RootKey = 'tenants'

    public constructor(location: string | IRecordMap<TenantRecord>)
    {
        super(location, TenantRegistry.RootKey)
    }
}
