import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Channel } from '../../channel.js'
import { ReleaseDescriptorCodec, ReleaseDescriptorInvalidError } from '../release-descriptor.js'
import type { ReleaseDescriptor } from '../release-descriptor.js'
import { ReleaseApp, ReleaseApps } from '../release-tag.js'

class DescriptorFixture
{
    public static Make(): ReleaseDescriptor
    {
        const images: Partial<Record<ReleaseApp, { repository: string; digest: string; signature: string }>> = {}
        for (const app of ReleaseApps.All)
        {
            images[app] = { repository: `ghcr.io/pragmatic-tech-ai/${app}`, digest: `sha256:${'a'.repeat(64)}`, signature: 'c2ln' }
        }
        return {
            schema: 1,
            version: '1.4.0',
            channel: Channel.Stable,
            serverCommit: 'b'.repeat(40),
            siblingCommits: { todl: 'c'.repeat(40), mural: 'd'.repeat(40) },
            builtAt: '2026-11-12T00:00:00Z',
            signingKeyId: 'release-2026-11',
            images: images as ReleaseDescriptor['images'],
        }
    }

    public static Bytes(value: unknown): Uint8Array
    {
        return new TextEncoder().encode(JSON.stringify(value))
    }
}

describe('ReleaseDescriptorCodec', () =>
{
    it('round-trips a full descriptor', () =>
    {
        const d = DescriptorFixture.Make()
        assert.deepEqual(ReleaseDescriptorCodec.Decode(ReleaseDescriptorCodec.Encode(d)), d)
    })

    it('encodes identically regardless of key insertion order', () =>
    {
        const a = DescriptorFixture.Make()
        const b = JSON.parse(JSON.stringify(a)) as Record<string, unknown>
        const reordered: Record<string, unknown> = {}
        for (const key of Object.keys(b).reverse())
        {
            reordered[key] = b[key]
        }
        reordered.siblingCommits = { mural: 'd'.repeat(40), todl: 'c'.repeat(40) }
        const bytesA = Buffer.from(ReleaseDescriptorCodec.Encode(a))
        const bytesB = Buffer.from(ReleaseDescriptorCodec.Encode(reordered as unknown as ReleaseDescriptor))
        assert.ok(bytesA.equals(bytesB))
        assert.ok(!bytesA.toString().includes(' '))
    })

    it('rejects a missing image entry', () =>
    {
        const d = DescriptorFixture.Make() as unknown as { images: Record<string, unknown> }
        delete d.images[ReleaseApp.UiUnpack]
        assert.throws(() => ReleaseDescriptorCodec.Decode(DescriptorFixture.Bytes(d)), ReleaseDescriptorInvalidError)
    })

    it('rejects a malformed digest', () =>
    {
        const d = DescriptorFixture.Make()
        d.images[ReleaseApp.EnvServer].digest = 'sha256:abc'
        assert.throws(() => ReleaseDescriptorCodec.Decode(DescriptorFixture.Bytes(d)), ReleaseDescriptorInvalidError)
    })

    it('rejects an unknown schema', () =>
    {
        const d = { ...DescriptorFixture.Make(), schema: 2 }
        assert.throws(() => ReleaseDescriptorCodec.Decode(DescriptorFixture.Bytes(d)), ReleaseDescriptorInvalidError)
    })

    it('rejects a malformed commit', () =>
    {
        const d = { ...DescriptorFixture.Make(), serverCommit: 'abc' }
        assert.throws(() => ReleaseDescriptorCodec.Decode(DescriptorFixture.Bytes(d)), ReleaseDescriptorInvalidError)
    })

    it('rejects non-JSON bytes', () =>
    {
        assert.throws(() => ReleaseDescriptorCodec.Decode(new TextEncoder().encode('nope')), ReleaseDescriptorInvalidError)
    })
})
