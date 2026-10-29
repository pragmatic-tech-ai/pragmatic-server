import { JsonRecordStore } from './json-record-store.js'
import type { Channel } from './channel.js'

export type ManifestRecord = {
    id: string
    image: string
    notes?: string
    publishedAt: string
    /** Set once the operator withdraws the version: a withdrawn version is shown struck-through and is not offered as a roll target. */
    withdrawn?: boolean
    /** Release channel the version was published to. */
    channel?: Channel
    /** Content digest of the image at publish time; absent when it could not be inspected. */
    digest?: string
    /** True only when a signature for the digest exists in the signature store. */
    signed?: boolean
    /** Why, by whom and when the version was withdrawn. */
    withdrawal?: { reason: string; actor: string; at: string }
}

export class ManifestRegistry extends JsonRecordStore<ManifestRecord>
{
    private static readonly RootKey = 'manifests'

    public constructor(filePath: string)
    {
        super(filePath, ManifestRegistry.RootKey)
    }
}
