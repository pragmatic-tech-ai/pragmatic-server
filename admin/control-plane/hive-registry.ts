import { JsonRecordStore, type IRecordMap, type HiveRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

export class HiveRegistry extends JsonRecordStore<HiveRecord>
{
    public static readonly RootKey = 'hives'

    public constructor(location: string | IRecordMap<HiveRecord>)
    {
        super(location, HiveRegistry.RootKey)
    }
}
