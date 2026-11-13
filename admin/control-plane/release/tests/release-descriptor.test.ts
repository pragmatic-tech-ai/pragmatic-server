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

    public static readonly Commit = 'e'.repeat(40)
    public static readonly ShortCommit = 'e'.repeat(39)
    public static readonly Proto = '__proto__'
    public static readonly ProtoSiblings = `{"${DescriptorFixture.Proto}":"${DescriptorFixture.Commit}"}`
    public static readonly BadNames: readonly string[] = ['a b', 'a/b', '.', '..', '']
    public static readonly GoodNames: readonly string[] = ['todl', 'TODL', 'todl-identity', 'pragmatic.graph', 'a_b', '.github']
    private static readonly SiblingsKey = 'siblingCommits'
    private static readonly ObjectClose = '}'

    public static Bytes(value: unknown): Uint8Array
    {
        return new TextEncoder().encode(JSON.stringify(value))
    }

    /** The descriptor's JSON with `siblingsJson` spliced in verbatim as its siblingCommits value. */
    public static RawWithSiblings(rest: object, siblingsJson: string): Uint8Array
    {
        const S = DescriptorFixture
        const body = JSON.stringify(rest)
        const raw = body.slice(0, -S.ObjectClose.length) + `,${JSON.stringify(S.SiblingsKey)}:${siblingsJson}` + S.ObjectClose
        return new TextEncoder().encode(raw)
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

    it('rejects empty repository, signature and signingKeyId', () =>
    {
        const noRepo = DescriptorFixture.Make()
        noRepo.images[ReleaseApp.EnvServer].repository = ''
        const noSig = DescriptorFixture.Make()
        noSig.images[ReleaseApp.EnvServer].signature = ''
        const noKey = { ...DescriptorFixture.Make(), signingKeyId: '' }
        for (const d of [noRepo, noSig, noKey])
        {
            assert.throws(() => ReleaseDescriptorCodec.Decode(DescriptorFixture.Bytes(d)), ReleaseDescriptorInvalidError)
        }
    })

    it('rejects sibling names that are not plain repo names', () =>
    {
        // JSON.parse keeps a literal "__proto__" key as an own property, so the raw JSON is assembled from its parts.
        const { siblingCommits: _siblings, ...rest } = DescriptorFixture.Make()
        const proto = DescriptorFixture.RawWithSiblings(rest, DescriptorFixture.ProtoSiblings)
        assert.throws(() => ReleaseDescriptorCodec.Decode(proto), ReleaseDescriptorInvalidError)
        for (const name of DescriptorFixture.BadNames)
        {
            const bad = { ...DescriptorFixture.Make(), siblingCommits: { [name]: DescriptorFixture.Commit } }
            assert.throws(() => ReleaseDescriptorCodec.Decode(DescriptorFixture.Bytes(bad)), ReleaseDescriptorInvalidError, name)
        }
    })

    it('rejects a sibling commit that is not 40 hex, and a non-string commit', () =>
    {
        for (const commit of [DescriptorFixture.ShortCommit, 7])
        {
            const bad = { ...DescriptorFixture.Make(), siblingCommits: { todl: commit } }
            assert.throws(() => ReleaseDescriptorCodec.Decode(DescriptorFixture.Bytes(bad)), /siblingCommits/)
        }
    })

    it('shares one repository-name rule: plain names pass, dot segments, __proto__ and separators fail', () =>
    {
        for (const name of DescriptorFixture.GoodNames)
        {
            assert.ok(ReleaseDescriptorCodec.IsRepoName(name), name)
        }
        for (const name of [...DescriptorFixture.BadNames, DescriptorFixture.Proto])
        {
            assert.ok(!ReleaseDescriptorCodec.IsRepoName(name), name)
        }
    })

    it('reports the first failure in the documented field order', () =>
    {
        const d = { ...DescriptorFixture.Make(), version: '', serverCommit: 'abc', signingKeyId: '' }
        assert.throws(() => ReleaseDescriptorCodec.Decode(DescriptorFixture.Bytes(d)), /field: version/)
        const e = { ...DescriptorFixture.Make(), serverCommit: 'abc', signingKeyId: '' }
        assert.throws(() => ReleaseDescriptorCodec.Decode(DescriptorFixture.Bytes(e)), /serverCommit/)
    })

    it('rejects non-JSON bytes', () =>
    {
        assert.throws(() => ReleaseDescriptorCodec.Decode(new TextEncoder().encode('nope')), ReleaseDescriptorInvalidError)
    })
})
