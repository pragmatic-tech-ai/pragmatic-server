import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStorage } from '../../engine/tests/engine-host-fixture.js'
import { TodlSourceCollector } from '../todl-source-collector.js'

// moved from dev-model-writer.test.ts (the collector outlives the legacy writer: SavedMemberReader reads with it)
class CollectorFx
{
    public static readonly Schema = 'namespace shop {\n  concept Customer { name : string?; }\n}\n'
    public static readonly Model = 'namespace shop {\n  model M : shop {\n    Customer c1 { name = "Ada"; }\n  }\n}\n'

    public static Storage(): MemoryStorage
    {
        return new MemoryStorage('mem', { 'model.todl': CollectorFx.Model, 'dist/skip.todl': 'garbage', 'readme.md': 'x' })
    }
}

test('collector skips build and vendor directories at any depth', async () =>
{
    const storage = CollectorFx.Storage()
    for (const dir of ['node_modules/pkg', '.git/x', 'out', 'build', 'sub/node_modules/pkg', 'sub/dist', 'sub/deep/.git']) storage.Files.set(dir + '/hidden.todl', 'garbage')
    storage.Files.set('schema.todl', CollectorFx.Schema)
    storage.Files.set('sub/kept.todl', CollectorFx.Schema)
    const uris = (await new TodlSourceCollector().Collect(storage)).map(s => s.uri).sort()
    assert.deepEqual(uris, ['model.todl', 'schema.todl', 'sub/kept.todl'])
})

test('SourceHash is stable and changes with a source', async () =>
{
    const storage = CollectorFx.Storage()
    const collector = new TodlSourceCollector()
    const a = collector.SourceHash(await collector.Collect(storage))
    const b = collector.SourceHash(await collector.Collect(storage))
    assert.equal(a, b)
    storage.Files.set('model.todl', CollectorFx.Model + '\n')
    assert.notEqual(collector.SourceHash(await collector.Collect(storage)), a)
})
