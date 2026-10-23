import { JsonRecordStore } from './json-record-store.js'

export type ManifestRecord = {
    id: string
    image: string
    notes?: string
    publishedAt: string
    /** Set once the operator withdraws the version: a withdrawn version is shown struck-through and is not offered as a roll target. */
    withdrawn?: boolean
}

export class ManifestRegistry extends JsonRecordStore<ManifestRecord>
{
    private static readonly RootKey = 'manifests'

    public constructor(filePath: string)
    {
        super(filePath, ManifestRegistry.RootKey)
    }
}
