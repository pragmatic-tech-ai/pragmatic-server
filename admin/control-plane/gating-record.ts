import { JsonRecordStore } from './json-record-store.js'

export type GatingRecord = {
    id: string
    tenantId: string
    version: string
    gatedAt: string
}

export class GatingRegistry extends JsonRecordStore<GatingRecord>
{
    private static readonly RootKey = 'gating'

    public constructor(filePath: string)
    {
        super(filePath, GatingRegistry.RootKey)
    }
}
