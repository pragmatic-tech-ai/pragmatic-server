import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RegistryRefImageDigest, TagReferenceError } from '../image-digest.js'

class Refs
{
    public static readonly Digest = 'sha256:' + 'a'.repeat(64)
    public static readonly ByDigest = 'ghcr.io/pragmatic-tech-ai/pragmatic-hive-agent@' + Refs.Digest
    public static readonly LocalTag = 'pragmatic-server:dev'
    public static readonly RegistryTag = 'ghcr.io/x/y:1.0'
    public static readonly ShortDigest = 'ghcr.io/x/y@sha256:abc'
}

describe('RegistryRefImageDigest', () =>
{
    it('returns the digest of a by-digest reference', async () =>
    {
        assert.equal(await new RegistryRefImageDigest().Of(Refs.ByDigest), Refs.Digest)
    })

    it('refuses a tag reference without calling docker', async () =>
    {
        const digests = new RegistryRefImageDigest()
        for (const ref of [Refs.LocalTag, Refs.RegistryTag, Refs.ShortDigest])
        {
            await assert.rejects(digests.Of(ref), (err: unknown) =>
                err instanceof TagReferenceError && err.message === 'Image ' + ref + ' is not pinned by digest')
        }
    })
})
