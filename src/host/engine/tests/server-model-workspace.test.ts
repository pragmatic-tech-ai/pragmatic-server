import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessScope, Cypher, GraphEngine, StorageKind } from '@pragmatic-tech-ai/graph'
import { EngineBridgeError, EngineBridgeErrorCode, TodlFileConnector } from '@pragmatic-tech-ai/todl/engine'
import type { ITodlDraftSession, ITodlModelWorkspace } from '@pragmatic-tech-ai/todl/engine'
import { TodlSourceCollector } from '../../model/todl-source-collector.js'
import { DevSnapshotSource } from '../dev-snapshot-source.js'
import { ServerModelWorkspace } from '../server-model-workspace.js'
import { EngineHostFx, HeldFence } from './engine-host-fixture.js'

/**
 * The server workspace whose sessions, once the connector has taken its baseline, also emit a NEW file (first) beside
 * the model's own: a commit that creates a file, so its restore must remove it again.
 */
class NewFileWorkspace implements ITodlModelWorkspace
{
    public static readonly Text = 'namespace shop { }\n'

    public constructor(private readonly inner: ServerModelWorkspace, private readonly uri: string)
    {
    }

    public async OpenDraft(model: string): Promise<ITodlDraftSession | undefined>
    {
        const session = await this.inner.OpenDraft(model)
        if (session === undefined) return undefined
        let emissions = 0
        const uri = this.uri
        const draft = new Proxy(session.Draft, {
            get: (target, name) => (name === 'toTodlByFile'
                ? () =>
                {
                    const files = target.toTodlByFile()
                    emissions += 1
                    return emissions === 1 ? files : new Map([[uri, NewFileWorkspace.Text], ...files])
                }
                : NewFileWorkspace.Bound(target, name)),
        })
        return new Proxy(session, { get: (target, name) => (name === 'Draft' ? draft : NewFileWorkspace.Bound(target, name)) })
    }

    private static Bound(target: object, name: string | symbol): unknown
    {
        const value: unknown = Reflect.get(target, name, target)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    }
}

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
    public static readonly Renamed = EngineHostFx.SourceA.replace('Ada', 'Renamed')
    public static readonly Unrestored = /could not be restored/

    /** The workspace with a held write fence installed (as DevCypherExecute installs its lease). */
    public static Workspace(fx: EngineHostFx): ServerModelWorkspace
    {
        return new ServerModelWorkspace(fx.Source, fx.Lang, undefined, undefined, HeldFence.Slot())
    }

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

    public static async Open(fx: EngineHostFx, workspace: ITodlModelWorkspace = WorkspaceFx.Workspace(fx)): Promise<GraphEngine>
    {
        const description = await new DevSnapshotSource(fx.Source, fx.Lang).Current()
        const connector = new TodlFileConnector(workspace)
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
        const session = await WorkspaceFx.Workspace(fx).OpenDraft(EngineHostFx.ModelN)
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
        const workspace = WorkspaceFx.Workspace(fx)
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
        const session = (await WorkspaceFx.Workspace(fx).OpenDraft(EngineHostFx.ModelM))!
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
        const session = (await WorkspaceFx.Workspace(fx).OpenDraft(EngineHostFx.ModelM))!
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
        const session = (await WorkspaceFx.Workspace(fx).OpenDraft(EngineHostFx.ModelM))!
        fx.A.Files.set(EngineHostFx.File, EngineHostFx.SourceA.replace('Ada', 'Other'))
        await assert.rejects(session.WriteFile(EngineHostFx.File, EngineHostFx.SourceA), WorkspaceFx.IsStale)
        assert.match(fx.A.Files.get(EngineHostFx.File)!, /Other/)
        assert.deepEqual(fx.Lang.Changes, [])
    })

    test('a write of the text a file already holds is a no-op, even over another writer\'s change (same commit, other model)', async () =>
    {
        const fx = new EngineHostFx()
        const session = (await WorkspaceFx.Workspace(fx).OpenDraft(EngineHostFx.ModelM))!
        fx.A.Files.set(EngineHostFx.File, WorkspaceFx.Renamed)
        await session.WriteFile(EngineHostFx.File, WorkspaceFx.Renamed)
        assert.equal(fx.A.Files.get(EngineHostFx.File), WorkspaceFx.Renamed)
        assert.deepEqual(fx.Lang.Changes, [], 'nothing was written, so nothing is refreshed')
    })

    test('a failed commit that had created a new file removes it again: no file storage did not hold is left', async () =>
    {
        const fx = new EngineHostFx()
        const engine = await WorkspaceFx.Open(fx, new NewFileWorkspace(WorkspaceFx.Workspace(fx), WorkspaceFx.NewFile))
        try
        {
            const before = [...fx.A.Files.keys()].sort()
            let wrote = false
            fx.Lang.OnIdle = () =>
            {
                if (wrote) return
                // the new file landed; another writer now changes the model's own file, so its write is refused (Stale)
                wrote = true
                assert.equal(fx.A.Files.get(WorkspaceFx.NewFile), NewFileWorkspace.Text, 'the commit did create the file')
                fx.A.Files.set(EngineHostFx.File, WorkspaceFx.Renamed)
            }
            const failure = await WorkspaceFx.Failure(new Cypher.CypherEngine(engine).Execute(AccessScope.System, WorkspaceFx.RenameAda))
            assert.ok(WorkspaceFx.Chain(failure).some(WorkspaceFx.IsStale), String(failure))
            assert.ok(wrote)
            assert.equal(fx.A.Files.has(WorkspaceFx.NewFile), false, 'the restore deleted the file the commit created')
            assert.deepEqual([...fx.A.Files.keys()].sort(), before)
            assert.deepEqual(fx.Lang.Deletes, [EngineHostFx.RootA + '/' + WorkspaceFx.NewFile])
        }
        finally
        {
            await engine.dispose()
        }
    })

    test('with no write fence installed a session refuses every write as Stale, untouched (fail closed)', async () =>
    {
        const fx = new EngineHostFx()
        const session = (await new ServerModelWorkspace(fx.Source, fx.Lang).OpenDraft(EngineHostFx.ModelM))!
        await assert.rejects(session.WriteFile(EngineHostFx.File, WorkspaceFx.Renamed), WorkspaceFx.IsStale)
        await assert.rejects(session.WriteFile(WorkspaceFx.NewFile, EngineHostFx.SourceA), WorkspaceFx.IsStale)
        await assert.rejects(session.DeleteFile(EngineHostFx.File), WorkspaceFx.IsStale)
        assert.equal(fx.A.Files.get(EngineHostFx.File), EngineHostFx.SourceA)
        assert.equal(fx.A.Files.has(WorkspaceFx.NewFile), false)
        assert.deepEqual(fx.Lang.Changes, [])
        assert.deepEqual(fx.Lang.Deletes, [])
    })
})
