import { JsonRecordStore } from './json-record-store.js'

export type SelectionRecord = {
    id: string
    hiveId: string
    targetVersion: string
    selectedAt: string
}

export class SelectionRegistry extends JsonRecordStore<SelectionRecord>
{
    private static readonly RootKey = 'selections'

    public constructor(filePath: string)
    {
        super(filePath, SelectionRegistry.RootKey)
    }
}
