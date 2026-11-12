import { Channel } from '../channel.js'
import { ReleaseApp, ReleaseApps } from './release-tag.js'

export type ReleaseImage = { repository: string; digest: string; signature: string }

export type ReleaseDescriptor = {
    schema: 1
    version: string
    channel: Channel
    serverCommit: string
    siblingCommits: Record<string, string>
    builtAt: string
    signingKeyId: string
    images: Record<ReleaseApp, ReleaseImage>
}

export class ReleaseDescriptorInvalidError extends Error
{
    private static readonly ErrorName = 'ReleaseDescriptorInvalidError'
    private static readonly MessagePrefix = 'Invalid release descriptor: '

    public constructor(reason: string)
    {
        super(ReleaseDescriptorInvalidError.MessagePrefix + reason)
        this.name = ReleaseDescriptorInvalidError.ErrorName
    }
}

/** Canonical (sorted-key, whitespace-free) JSON codec so the descriptor's sha256 is stable. */
export class ReleaseDescriptorCodec
{
    private static readonly SchemaVersion = 1
    private static readonly DigestPattern = /^sha256:[0-9a-f]{64}$/
    private static readonly CommitPattern = /^[0-9a-f]{40}$/
    private static readonly RepoNamePattern = /^(?!__proto__$)[A-Za-z0-9._-]+$/
    private static readonly NotObject = 'not an object'
    private static readonly NotJson = 'not valid JSON'
    private static readonly BadSchema = 'schema must be 1'
    private static readonly BadChannel = 'channel is not a known channel'
    private static readonly BadServerCommit = 'serverCommit is not a 40-hex commit'
    private static readonly BadSiblingCommits = 'siblingCommits must map names to 40-hex commits'
    private static readonly MissingFieldPrefix = 'missing or ill-shaped field: '
    private static readonly MissingImagePrefix = 'missing image: '
    private static readonly BadImagePrefix = 'ill-shaped image: '
    private static readonly BadDigestPrefix = 'bad digest for image: '
    private static readonly FieldVersion = 'version'
    private static readonly FieldBuiltAt = 'builtAt'
    private static readonly FieldSigningKeyId = 'signingKeyId'
    private static readonly FieldImages = 'images'

    public static Encode(d: ReleaseDescriptor): Uint8Array
    {
        return new TextEncoder().encode(JSON.stringify(ReleaseDescriptorCodec.sortKeys(d)))
    }

    /** Validates in a fixed order: schema, version, channel, serverCommit, siblingCommits, builtAt, signingKeyId, images. */
    public static Decode(bytes: Uint8Array): ReleaseDescriptor
    {
        let raw: unknown
        try
        {
            raw = JSON.parse(new TextDecoder().decode(bytes))
        }
        catch
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.NotJson)
        }
        if (!ReleaseDescriptorCodec.isRecord(raw))
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.NotObject)
        }
        if (raw.schema !== ReleaseDescriptorCodec.SchemaVersion)
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadSchema)
        }
        const version = ReleaseDescriptorCodec.requireString(raw, ReleaseDescriptorCodec.FieldVersion)
        if (!Object.values(Channel).includes(raw.channel as Channel))
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadChannel)
        }
        if (typeof raw.serverCommit !== 'string' || !ReleaseDescriptorCodec.CommitPattern.test(raw.serverCommit))
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadServerCommit)
        }
        const siblingCommits = ReleaseDescriptorCodec.decodeSiblings(raw.siblingCommits)
        const builtAt = ReleaseDescriptorCodec.requireString(raw, ReleaseDescriptorCodec.FieldBuiltAt)
        const signingKeyId = ReleaseDescriptorCodec.requireString(raw, ReleaseDescriptorCodec.FieldSigningKeyId)
        const images = ReleaseDescriptorCodec.decodeImages(raw.images)
        return {
            schema: 1,
            version,
            channel: raw.channel as Channel,
            serverCommit: raw.serverCommit,
            siblingCommits,
            builtAt,
            signingKeyId,
            images,
        }
    }

    private static decodeSiblings(value: unknown): Record<string, string>
    {
        if (!ReleaseDescriptorCodec.isRecord(value))
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadSiblingCommits)
        }
        const result: Record<string, string> = {}
        for (const [name, commit] of Object.entries(value))
        {
            if (!ReleaseDescriptorCodec.RepoNamePattern.test(name) || typeof commit !== 'string' || !ReleaseDescriptorCodec.CommitPattern.test(commit))
            {
                throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadSiblingCommits)
            }
            result[name] = commit
        }
        return result
    }

    private static decodeImages(value: unknown): Record<ReleaseApp, ReleaseImage>
    {
        if (!ReleaseDescriptorCodec.isRecord(value))
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.MissingFieldPrefix + ReleaseDescriptorCodec.FieldImages)
        }
        const result: Partial<Record<ReleaseApp, ReleaseImage>> = {}
        for (const app of ReleaseApps.All)
        {
            const image = value[app]
            if (image === undefined)
            {
                throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.MissingImagePrefix + app)
            }
            if (!ReleaseDescriptorCodec.isRecord(image)
                || typeof image.repository !== 'string'
                || image.repository.length === 0
                || typeof image.digest !== 'string'
                || typeof image.signature !== 'string'
                || image.signature.length === 0)
            {
                throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadImagePrefix + app)
            }
            if (!ReleaseDescriptorCodec.DigestPattern.test(image.digest))
            {
                throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadDigestPrefix + app)
            }
            result[app] = { repository: image.repository, digest: image.digest, signature: image.signature }
        }
        return result as Record<ReleaseApp, ReleaseImage>
    }

    private static requireString(raw: Record<string, unknown>, field: string): string
    {
        const value = raw[field]
        if (typeof value !== 'string' || value.length === 0)
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.MissingFieldPrefix + field)
        }
        return value
    }

    private static isRecord(value: unknown): value is Record<string, unknown>
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    private static sortKeys(value: unknown): unknown
    {
        if (Array.isArray(value))
        {
            return value.map(item => ReleaseDescriptorCodec.sortKeys(item))
        }
        if (ReleaseDescriptorCodec.isRecord(value))
        {
            const sorted: Record<string, unknown> = {}
            for (const key of Object.keys(value).sort())
            {
                sorted[key] = ReleaseDescriptorCodec.sortKeys(value[key])
            }
            return sorted
        }
        return value
    }
}
