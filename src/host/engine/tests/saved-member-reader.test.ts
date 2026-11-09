import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { DeclaredModelCache, SavedMemberReader } from '../saved-member-reader.js'
import { DevSnapshotSource } from '../dev-snapshot-source.js'
import { ServerModelWorkspace } from '../server-model-workspace.js'
import { EngineHostFx } from './engine-host-fixture.js'

/** Counts the member compiles the cache could not answer. */
class CountingCache extends DeclaredModelCache
{
    public Compiles = 0

    public override ModelsOf(storage: IStorage, sourceHash: string, compile: () => readonly string[]): readonly string[]
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
})
