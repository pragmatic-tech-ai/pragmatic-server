import { JsonRecordStore } from './json-record-store.js'
import type { Channel } from './channel.js'
import type { ReleaseApp } from './release/release-tag.js'

/** Outcome of verifying a registry release on import. */
export enum ReleaseState
{
    Verified = 'verified',
    Rejected = 'rejected',
}

/** Provenance of a manifest imported from a registry release descriptor; absent on locally published manifests. */
export type ManifestRelease = {
    state: ReleaseState
    serverCommit?: string
    siblingCommits?: Record<string, string>
    builtAt?: string
    signingKeyId?: string
    images?: Record<ReleaseApp, { repository: string; digest: string }>
    /** Why verification failed: names the check and the app or key id only. */
    rejectedReason?: string
}

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
    /** Set only for a version imported from the release registry. */
    release?: ManifestRelease
}

export class ManifestRegistry extends JsonRecordStore<ManifestRecord>
{
    private static readonly RootKey = 'manifests'

    public constructor(filePath: string)
    {
        super(filePath, ManifestRegistry.RootKey)
    }
}
