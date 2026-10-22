import { JsonRecordStore } from './json-record-store.js'

export type ManifestRecord = {
    id: string
    image: string
    notes?: string
    publishedAt: string
}

export class ManifestRegistry extends JsonRecordStore<ManifestRecord>
{
    private static readonly RootKey = 'manifests'

    public constructor(filePath: string)
    {
        super(filePath, ManifestRegistry.RootKey)
    }
}
