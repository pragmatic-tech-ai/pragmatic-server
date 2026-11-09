import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessScope, Cypher, GraphEngine, StorageKind } from '@pragmatic-tech-ai/graph'
import { EngineBridgeError, EngineBridgeErrorCode, TodlFileConnector } from '@pragmatic-tech-ai/todl/engine'
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

    public static readonly RenameAda = "MATCH (n:shop.Customer {name: 'Ada'}) SET n.name = 'Ann'"
    public static readonly Names = 'MATCH (n:shop.Customer) RETURN n.name AS name ORDER BY name'
    public static readonly NewFile = 'new.todl'
    public static readonly Unrestored = /could not be restored/

    /** A session's stale refusal: EngineBridgeError with code Stale. */
    public static IsStale(error: unknown): boolean
    {
        return error instanceof EngineBridgeError && error.Code === EngineBridgeErrorCode.Stale
    }

    public static async Failure(work: Promise<unknown>): Promise<unknown>
    {
        try
        {
            await work
        }
        catch (error)
        {
            return error
        }
        assert.fail('expected the statement to fail')
    }

    /** The error and its causes, outermost first. */
    public static Chain(error: unknown): Error[]
    {
        const chain: Error[] = []
        for (let at = error; at instanceof Error; at = at.cause) chain.push(at)
        return chain
    }

    public static async Run(fx: EngineHostFx, query: string): Promise<void>
    {
        const engine = await WorkspaceFx.Open(fx)
        try
        {
            await new Cypher.CypherEngine(engine).Execute(AccessScope.System, query)
        }
        finally
        {
            await engine.dispose()
        }
    }

    public static async Open(fx: EngineHostFx): Promise<GraphEngine>
    {
        const description = await new DevSnapshotSource(fx.Source, fx.Lang).Current()
        const connector = new TodlFileConnector(new ServerModelWorkspace(fx.Source, fx.Lang))
        return GraphEngine.Open({ Description: description.Description, Storage: { Kind: StorageKind.Memory }, Connectors: [connector] })
    }

    /** The customer names the engine holds, in order. */
    public static async NamesIn(engine: GraphEngine): Promise<unknown[]>
    {
        const result = await new Cypher.CypherEngine(engine).Execute(AccessScope.System, WorkspaceFx.Names)
        return result.Rows.map(row => row[0])
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
        assert.equal(fx.Lang.Idles, fx.Lang.Changes.length, 'the language service was awaited idle after each write')
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

    test('two models sharing one file cannot both write it in one commit', async () =>
    {
        const fx = new EngineHostFx()
        const shared = fx.ShareOneFile()
        const engine = await WorkspaceFx.Open(fx)
        try
        {
            const before = await WorkspaceFx.NamesIn(engine)
            const failure = await WorkspaceFx.Failure(new Cypher.CypherEngine(engine).Execute(AccessScope.System, WorkspaceFx.RenameBoth))
            assert.ok(WorkspaceFx.Chain(failure).some(WorkspaceFx.IsStale), String(failure))
            assert.ok(!WorkspaceFx.Chain(failure).some(e => WorkspaceFx.Unrestored.test(e.message)), 'nothing is reported unrestored: ' + String(failure))
            assert.equal(shared.Files.get(EngineHostFx.SharedFile), EngineHostFx.Shared, 'the shared file is unchanged')
            assert.deepEqual(await WorkspaceFx.NamesIn(engine), before, 'the engine data is unchanged')
        }
        finally
        {
            await engine.dispose()
        }
    })

    test('an edit to one of two models sharing a file succeeds', async () =>
    {
        const fx = new EngineHostFx()
        const shared = fx.ShareOneFile()
        await WorkspaceFx.Run(fx, WorkspaceFx.RenameAda)
        const text = shared.Files.get(EngineHostFx.SharedFile)!
        assert.match(text, new RegExp(WorkspaceFx.Ann))
        assert.match(text, /name = "Bo"/)
    })

    test('a deleted file leaves the language service view, not an empty buffer', async () =>
    {
        const fx = new EngineHostFx()
        const session = (await new ServerModelWorkspace(fx.Source, fx.Lang).OpenDraft(EngineHostFx.ModelM))!
        const uri = EngineHostFx.RootA + '/' + WorkspaceFx.NewFile
        await session.WriteFile(WorkspaceFx.NewFile, EngineHostFx.SourceA)
        assert.equal(fx.Lang.Buffers.get(uri), EngineHostFx.SourceA)
        await session.DeleteFile(WorkspaceFx.NewFile)
        assert.equal(fx.A.Files.has(WorkspaceFx.NewFile), false)
        assert.deepEqual(fx.Lang.Deletes, [uri])
        assert.equal(fx.Lang.Buffers.has(uri), false)
        assert.equal(fx.Lang.Idles, 2)
    })

    test('a write over a file another writer changed is stale', async () =>
    {
        const fx = new EngineHostFx()
        const session = (await new ServerModelWorkspace(fx.Source, fx.Lang).OpenDraft(EngineHostFx.ModelM))!
        fx.A.Files.set(EngineHostFx.File, EngineHostFx.SourceA.replace('Ada', 'Other'))
        await assert.rejects(session.WriteFile(EngineHostFx.File, EngineHostFx.SourceA), WorkspaceFx.IsStale)
        assert.match(fx.A.Files.get(EngineHostFx.File)!, /Other/)
        assert.deepEqual(fx.Lang.Changes, [])
    })
})
