import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { DevSnapshotSource } from '../dev-snapshot-source.js'
import { EngineHostFx, FakeSolution, MemoryStorage } from './engine-host-fixture.js'

class SnapshotFx
{
    public static readonly Unsaved = EngineHostFx.SourceA.replace('Ada', 'Unsaved')
    public static readonly Saved = EngineHostFx.SourceA.replace('Ada', 'Saved')
    public static readonly CatalogFile = 'catalog.todl'
    public static readonly Catalog = 'namespace cat {\n  concept Item { name : string?; }\n  model Stock : cat {\n    Item i1 { name = "Pen"; }\n  }\n}\n'
    public static readonly UseFile = 'use.todl'
    public static readonly Use = 'namespace cat {\n  model Desk : cat {\n    Item i2 { name = "Ink"; }\n  }\n}\n'
    public static readonly Stock = 'cat.Stock'
    public static readonly Desk = 'cat.Desk'
    public static readonly I1 = 'cat.i1'
    public static readonly I2 = 'cat.i2'

    public static OwnersOf(seed: readonly { PublicId: string; Owner: string }[], ids: readonly string[]): string[]
    {
        return ids.map(id => seed.find(n => n.PublicId === id)?.Owner ?? '')
    }
}

describe('DevSnapshotSource', () =>
{
    test('unsaved buffer does not reach the snapshot', async () =>
    {
        const fx = new EngineHostFx()
        const source = new DevSnapshotSource(fx.Source, fx.Lang)
        const before = (await source.Current()).Description.Version
        fx.Lang.DidChange(EngineHostFx.UriA, SnapshotFx.Unsaved)
        assert.equal((await source.Current()).Description.Version, before)
        fx.A.Files.set(EngineHostFx.File, SnapshotFx.Saved)
        const after = await source.Current()
        assert.notEqual(after.Description.Version, before)
        assert.equal(after.Description.DefaultConnector, TodlNames.FileConnector)
    })

    test('owner of every seed node is its model id', async () =>
    {
        const fx = new EngineHostFx()
        const current = await new DevSnapshotSource(fx.Source, fx.Lang).Current()
        assert.deepEqual(SnapshotFx.OwnersOf(current.Description.Seed, [EngineHostFx.C1, EngineHostFx.C2]), [EngineHostFx.ModelM, EngineHostFx.ModelN])
        assert.ok(current.Repository.has(EngineHostFx.C1))
        assert.ok(current.Repository.has(EngineHostFx.C2))
    })

    test('a member that is also a sibling\'s base compiles once, from its saved sources', async () =>
    {
        const fx = new EngineHostFx()
        const producer = new MemoryStorage('mem/p', { [SnapshotFx.CatalogFile]: SnapshotFx.Catalog })
        const consumer = new MemoryStorage('mem/c', { [SnapshotFx.UseFile]: SnapshotFx.Use })
        fx.Lang.ConsumeSibling(consumer, producer)
        fx.Solution = new FakeSolution(EngineHostFx.SolutionName, [{ Storage: producer }, { Storage: consumer }])
        const current = await new DevSnapshotSource(fx.Source, fx.Lang).Current()
        assert.deepEqual(SnapshotFx.OwnersOf(current.Description.Seed, [SnapshotFx.I1, SnapshotFx.I2]), [SnapshotFx.Stock, SnapshotFx.Desk])
    })

    test('an unchanged saved solution is not recompiled', async () =>
    {
        const fx = new EngineHostFx()
        const source = new DevSnapshotSource(fx.Source, fx.Lang)
        const first = await source.Current()
        fx.Lang.DidChange(EngineHostFx.UriA, SnapshotFx.Unsaved)
        assert.equal(await source.Current(), first, 'a buffer-only change returns the previous snapshot')
        fx.A.Files.set(EngineHostFx.File, SnapshotFx.Saved)
        const saved = await source.Current()
        assert.notEqual(saved, first)
        assert.notEqual(saved.Description.Version, first.Description.Version)
    })

    test('no active solution is an empty snapshot', async () =>
    {
        const fx = new EngineHostFx()
        fx.Solution = undefined
        const current = await new DevSnapshotSource(fx.Source, fx.Lang).Current()
        assert.deepEqual(current.Description.Seed.filter(n => n.PublicId === EngineHostFx.C1), [])
    })
})
