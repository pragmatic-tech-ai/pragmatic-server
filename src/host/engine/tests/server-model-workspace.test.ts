import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessScope, Cypher, GraphEngine, StorageKind } from '@pragmatic-tech-ai/graph'
import { TodlFileConnector } from '@pragmatic-tech-ai/todl/engine'
import { TodlSourceCollector } from '../../model/todl-source-collector.js'
import { DevSnapshotSource } from '../dev-snapshot-source.js'
import { ServerModelWorkspace } from '../server-model-workspace.js'
import { EngineHostFx } from './engine-host-fixture.js'

/** Opens a memory engine over the fixture's saved snapshot with the file connector over the server workspace. */
class WorkspaceFx
{
    public static readonly RenameBo = "MATCH (n:shop.Customer {name: 'Bo'}) SET n.name = 'Bea'"
    public static readonly RenameBoth = "MATCH (a:shop.Customer {name: 'Ada'}), (b:shop.Customer {name: 'Bo'}) SET a.name = 'Ann', b.name = 'Bea'"
    public static readonly Bea = 'name = "Bea"'
    public static readonly Ann = 'name = "Ann"'
    public static readonly Unknown = 'shop.Nope'

    public static async Run(fx: EngineHostFx, query: string): Promise<void>
    {
        const description = await new DevSnapshotSource(fx.Source, fx.Lang).Current()
        const connector = new TodlFileConnector(new ServerModelWorkspace(fx.Source, fx.Lang))
        const engine = await GraphEngine.Open({ Description: description.Description, Storage: { Kind: StorageKind.Memory }, Connectors: [connector] })
        try
        {
            await new Cypher.CypherEngine(engine).Execute(AccessScope.System, query)
        }
        finally
        {
            await engine.dispose()
        }
    }
}

describe('ServerModelWorkspace', () =>
{
    test('open draft for a member model edits that member\'s file', async () =>
    {
        const fx = new EngineHostFx()
        const session = await new ServerModelWorkspace(fx.Source, fx.Lang).OpenDraft(EngineHostFx.ModelN)
        assert.ok(session !== undefined)
        assert.equal(session.Namespace, EngineHostFx.Namespace)
        assert.ok(session.Draft.Owns(EngineHostFx.C2))
        assert.equal(session.Draft.Owns(EngineHostFx.C1), false)
        assert.equal(await session.ReadFile(EngineHostFx.File), EngineHostFx.SourceB)
        assert.equal(await session.ReadFile('absent.todl'), undefined)

        await WorkspaceFx.Run(fx, WorkspaceFx.RenameBo)
        assert.match(fx.B.Files.get(EngineHostFx.File)!, new RegExp(WorkspaceFx.Bea))
        assert.equal(fx.A.Files.get(EngineHostFx.File), EngineHostFx.SourceA)
    })

    test('non-member model is not editable', async () =>
    {
        const fx = new EngineHostFx()
        const workspace = new ServerModelWorkspace(fx.Source, fx.Lang)
        assert.equal(await workspace.OpenDraft(EngineHostFx.SolutionName), undefined)
        assert.equal(await workspace.OpenDraft(WorkspaceFx.Unknown), undefined)
        assert.equal(await workspace.OpenDraft(EngineHostFx.Namespace), undefined)
        fx.Solution = undefined
        assert.equal(await workspace.OpenDraft(EngineHostFx.ModelM), undefined)
    })

    test('commit notifies the language service once per written file', async () =>
    {
        const fx = new EngineHostFx()
        await WorkspaceFx.Run(fx, WorkspaceFx.RenameBoth)
        assert.deepEqual([...fx.Lang.Changes].sort(), [EngineHostFx.UriA, EngineHostFx.UriB])
        assert.equal(fx.Lang.Buffers.get(EngineHostFx.UriA), fx.A.Files.get(EngineHostFx.File))
        assert.equal(fx.Lang.Buffers.get(EngineHostFx.UriB), fx.B.Files.get(EngineHostFx.File))
        assert.match(fx.A.Files.get(EngineHostFx.File)!, new RegExp(WorkspaceFx.Ann))
        assert.ok(fx.Lang.Idles >= 1, 'the language service was awaited idle after the writes')
    })

    test('source hash changes when a file changes on disk', async () =>
    {
        const fx = new EngineHostFx()
        const collector = new TodlSourceCollector()
        const session = (await new ServerModelWorkspace(fx.Source, fx.Lang).OpenDraft(EngineHostFx.ModelM))!
        assert.equal(session.SourceHash, collector.SourceHash(await collector.Collect(fx.A)))
        assert.equal(await session.CurrentSourceHash(), session.SourceHash)
        fx.Lang.DidChange(EngineHostFx.UriA, EngineHostFx.SourceA.replace('Ada', 'Unsaved'))
        assert.equal(await session.CurrentSourceHash(), session.SourceHash, 'an unsaved buffer is not the file on disk')
        fx.A.Files.set(EngineHostFx.File, EngineHostFx.SourceA.replace('Ada', 'Saved'))
        assert.notEqual(await session.CurrentSourceHash(), session.SourceHash)
    })
})
