import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { WikiOriginKind } from '@pragmatic-tech-ai/todl'
import type { WikiOrigin } from '@pragmatic-tech-ai/todl'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { DeclaredModelCache, DeclaredModels, SavedMemberReader } from '../saved-member-reader.js'
import { DevSnapshotSource } from '../dev-snapshot-source.js'
import { ServerModelWorkspace } from '../server-model-workspace.js'
import { EngineHostFx, FakeLanguageService } from './engine-host-fixture.js'

/** A language service whose resolved bases carry the given origins (a published package, or an unknown kind). */
class OriginLanguageService extends FakeLanguageService
{
    public static readonly UnknownKind = 'bogus'
    public static readonly OriginId = 'shop.x'
    public static readonly PackageId = 'pkg'
    public static readonly Version = '1.0.0'

    public constructor(private readonly origin: WikiOrigin)
    {
        super()
    }

    public override async ResolveBasesFor(consumerStorage: IStorage): ReturnType<FakeLanguageService['ResolveBasesFor']>
    {
        const resolved = await super.ResolveBasesFor(consumerStorage)
        return { bases: resolved.bases, originOf: new Map([[OriginLanguageService.OriginId, this.origin]]) }
    }
}

/** Counts the member compiles the cache could not answer. */
class CountingCache extends DeclaredModelCache
{
    public Compiles = 0

    public override ModelsOf(storage: IStorage, sourceHash: string, compile: () => DeclaredModels): readonly string[]
    {
        return super.ModelsOf(storage, sourceHash, () =>
        {
            this.Compiles += 1
            return compile()
        })
    }
}

describe('SavedMemberReader', () =>
{
    test('an unchanged member is not recompiled, by the workspace or the snapshot source', async () =>
    {
        const fx = new EngineHostFx()
        const cache = new CountingCache()
        const reader = new SavedMemberReader(fx.Lang, undefined, cache)
        const source = new DevSnapshotSource(fx.Source, fx.Lang, reader)
        const workspace = new ServerModelWorkspace(fx.Source, fx.Lang, undefined, reader)
        await source.Current()
        assert.equal(cache.Compiles, 2, 'each member compiles once')
        assert.ok(await workspace.OpenDraft(EngineHostFx.ModelN))
        await source.Current()
        assert.equal(cache.Compiles, 2, 'the cached members are reused')

        fx.A.Files.set(EngineHostFx.File, EngineHostFx.SourceA.replace('model M', 'model P'))
        const member = await reader.Read(fx.A)
        assert.equal(cache.Compiles, 3, 'a changed member recompiles')
        assert.deepEqual(member.Models, ['shop.P'])
    })

    test('a member whose compile has errors is not cached', async () =>
    {
        const fx = new EngineHostFx()
        const cache = new CountingCache()
        const reader = new SavedMemberReader(fx.Lang, undefined, cache)
        fx.A.Files.set(EngineHostFx.File, EngineHostFx.SourceA.replace('name = "Ada";', 'name = ;'))
        await reader.Read(fx.A)
        await reader.Read(fx.A)
        assert.equal(cache.Compiles, 2, 'an erroring compile is retried')
    })

    test('the bases fingerprint covers every WikiOriginKind and throws on an unknown kind', async () =>
    {
        const fx = new EngineHostFx()
        const packaged = new SavedMemberReader(new OriginLanguageService({ kind: WikiOriginKind.Package, id: OriginLanguageService.PackageId, version: OriginLanguageService.Version }))
        const open = new SavedMemberReader(new OriginLanguageService({ kind: WikiOriginKind.OpenProject, storage: fx.B }))
        assert.notEqual((await packaged.Read(fx.A)).BasesHash, (await open.Read(fx.A)).BasesHash)
        const unknown = new SavedMemberReader(new OriginLanguageService({ kind: OriginLanguageService.UnknownKind } as unknown as WikiOrigin))
        await assert.rejects(unknown.Read(fx.A), new RegExp(OriginLanguageService.UnknownKind))
    })
})
