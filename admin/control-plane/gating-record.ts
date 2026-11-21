import { JsonRecordStore, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

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
