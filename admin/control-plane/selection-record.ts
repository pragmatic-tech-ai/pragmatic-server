import { JsonRecordStore, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

export type SelectionRecord = {
    id: string
    hiveId: string
    targetVersion: string
    selectedAt: string
}

export class SelectionRegistry extends JsonRecordStore<SelectionRecord>
{
    public static readonly RootKey = 'selections'

    public constructor(location: string | IRecordMap<SelectionRecord>)
    {
        super(location, SelectionRegistry.RootKey)
    }
}
