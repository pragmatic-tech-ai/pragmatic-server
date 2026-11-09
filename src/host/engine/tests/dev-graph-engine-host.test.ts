import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessScope, Cypher, GraphError, GraphErrorCode } from '@pragmatic-tech-ai/graph'
import type { ConnectorChangeSet, GraphEngine, IConnectorTransaction, IGraphConnector } from '@pragmatic-tech-ai/graph'
import { Disposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { DevGraphEngineHost, DevSnapshotCompileError, EngineWriteTracker } from '../dev-graph-engine-host.js'
import type { IDevEngineDiagnostics, IUpgradeTimer } from '../dev-graph-engine-host.js'
import { DevSnapshotSource } from '../dev-snapshot-source.js'
import { EngineHostFx, HeldFence } from './engine-host-fixture.js'

/** A debounce timer the test fires by hand: only the latest started work is pending. */
class ManualUpgradeTimer implements IUpgradeTimer
{
    public readonly Delays: number[] = []
    private pending: (() => void) | undefined

    public Start(delayMs: number, work: () => void): IDisposable
    {
        this.Delays.push(delayMs)
        this.pending = work
        return new Disposable(() =>
        {
            if (this.pending === work) this.pending = undefined
        })
    }

    public get Armed(): boolean
    {
        return this.pending !== undefined
    }

    public Fire(): void
    {
        const work = this.pending
        this.pending = undefined
        work?.()
    }
}

class RecordingDiagnostics implements IDevEngineDiagnostics
{
    public readonly Failures: unknown[] = []

    public readonly HandlerFailures: unknown[] = []

    public UpgradeFailed(error: unknown): void
    {
        this.Failures.push(error)
    }

    public ChangedHandlerFailed(error: unknown): void
    {
        this.HandlerFailures.push(error)
    }
}

/** A connector whose transactions do nothing: the tracker's bookkeeping alone is under test. */
class InertConnector implements IGraphConnector
{
    public readonly Name = 'inert'

    public async Begin(): Promise<IConnectorTransaction>
    {
        return { Apply: async (_changes: ConnectorChangeSet) => undefined, Commit: async () => undefined, Revert: async () => undefined }
    }
}

/** Whether a promise has settled after the current turn's microtasks and one macrotask. */
class Settles
{
    public static async Yet(promise: Promise<void>): Promise<boolean>
    {
        let settled = false
        void promise.then(() => { settled = true })
        await new Promise<void>(resolve => setImmediate(resolve))
        return settled
    }
}

/** One host over the two-member fixture, with a manual debounce. */
class HostFx
{
    public static readonly Names = 'MATCH (n:shop.Customer) RETURN n.name AS name ORDER BY name'
    public static readonly RenameBoth = "MATCH (a:shop.Customer {name: 'Ada'}), (b:shop.Customer {name: 'Bo'}) SET a.name = 'Ann', b.name = 'Bea'"
    public static readonly Cy = EngineHostFx.SourceA.replace('Ada', 'Cy')
    public static readonly Di = EngineHostFx.SourceA.replace('Ada', 'Di')
    public static readonly Broken = EngineHostFx.SourceA.replace('name = "Ada";', 'name = ;')
    public static readonly ResolveMessage = 'bases unavailable'
    public static readonly SubscriberMessage = 'subscriber failed'
    public static readonly RenameAda = "MATCH (n:shop.Customer {name: 'Ada'}) SET n.name = 'Ann'"
    public static readonly RenameBo = "MATCH (n:shop.Customer {name: 'Bo'}) SET n.name = 'Bea'"
    public static readonly ModelM = /model M : shop/
    public static readonly ModelN = /model N : shop/

    public readonly Fx = new EngineHostFx()
    public readonly Timer = new ManualUpgradeTimer()
    public readonly Diagnostics = new RecordingDiagnostics()
    public readonly Host = new DevGraphEngineHost(this.Fx.Source, () => Promise.resolve(this.Fx.Lang), this.Timer, this.Diagnostics)
    public Changes = 0

    public constructor()
    {
        this.Host.Changed.Subscribe(() => { this.Changes += 1 })
        // the tests write straight through the engine, without DevCypherExecute's lease: writes fail closed without a fence
        this.Host.InstallWriteFence(HeldFence.Instance)
    }

    /** Saves member a's file and raises the language service's change, as a real save does. */
    public Save(text: string): void
    {
        this.Fx.A.Files.set(EngineHostFx.File, text)
        this.Fx.Lang.RaiseGraphChanged()
    }

    /** Runs a write through the engine (its file connector writes the saved sources), then lets the upgrade run. */
    public async Write(engine: GraphEngine, statement: string): Promise<void>
    {
        await new Cypher.CypherEngine(engine).Execute(AccessScope.System, statement)
        this.Fx.Lang.RaiseGraphChanged()
        await this.Settle()
    }

    /** Lets the debounce elapse and waits for the upgrades it started. */
    public async Settle(): Promise<void>
    {
        this.Timer.Fire()
        await this.Host.WhenUpgraded()
    }

    /** The customer names the engine holds, in order (each cell a scalar's value). */
    public static async NamesIn(engine: GraphEngine): Promise<unknown[]>
    {
        const result = await new Cypher.CypherEngine(engine).Execute(AccessScope.System, HostFx.Names)
        return result.Rows.map(row => (row[0] as Cypher.ScalarValue).Value)
    }
}

describe('DevGraphEngineHost', () =>
{
    test('opens once and reuses', async () =>
    {
        const h = new HostFx()
        try
        {
            const [first, second] = await Promise.all([h.Host.Engine(), h.Host.Engine()])
            assert.equal(first, second)
            assert.equal(await h.Host.Engine(), first)
            assert.deepEqual(await HostFx.NamesIn(first), ['Ada', 'Bo'])
            const description = await h.Host.Description()
            assert.equal(description.Version, first.SchemaVersion)
            assert.ok((await h.Host.Repository()).has(EngineHostFx.C1))
            assert.equal(h.Fx.Lang.GraphChanged.subscriberCount, 1)
        }
        finally
        {
            await h.Host.dispose()
        }
    })

    test('saved edit upgrades the engine', async () =>
    {
        const h = new HostFx()
        try
        {
            const engine = await h.Host.Engine()
            const before = engine.SchemaVersion
            h.Save(HostFx.Cy)
            assert.deepEqual(h.Timer.Delays, [DevGraphEngineHost.UpgradeDebounceMs])
            assert.equal(h.Changes, 0, 'nothing upgrades before the debounce elapses')
            await h.Settle()
            assert.equal(h.Changes, 1)
            assert.notEqual(engine.SchemaVersion, before)
            assert.equal((await h.Host.Description()).Version, engine.SchemaVersion)
            assert.deepEqual(await HostFx.NamesIn(engine), ['Bo', 'Cy'])
            assert.deepEqual(h.Diagnostics.Failures, [])
        }
        finally
        {
            await h.Host.dispose()
        }
    })

    test('WhenUpgraded cuts a pending debounce short and upgrades to the saved state', async () =>
    {
        const h = new HostFx()
        try
        {
            assert.equal(await h.Host.WhenUpgraded(), undefined, 'nothing open: nothing to do')
            const engine = await h.Host.Engine()
            h.Save(HostFx.Cy)
            assert.ok(h.Timer.Armed)
            await h.Host.WhenUpgraded()
            assert.equal(h.Timer.Armed, false, 'the pending debounce is cancelled')
            assert.equal(h.Changes, 1)
            assert.deepEqual(await HostFx.NamesIn(engine), ['Bo', 'Cy'])
            await h.Host.WhenUpgraded()
            assert.equal(h.Changes, 1, 'nothing pending: no upgrade pass runs')
        }
        finally
        {
            await h.Host.dispose()
        }
    })

    test('unchanged recompile does not upgrade', async () =>
    {
        const h = new HostFx()
        try
        {
            const engine = await h.Host.Engine()
            const before = engine.SchemaVersion
            h.Fx.Lang.DidChange(EngineHostFx.UriA, HostFx.Cy)
            h.Fx.Lang.RaiseGraphChanged()
            await h.Settle()
            assert.equal(h.Changes, 0, 'an unsaved buffer does not change the saved snapshot')
            assert.equal(engine.SchemaVersion, before)
            assert.deepEqual(await HostFx.NamesIn(engine), ['Ada', 'Bo'])
        }
        finally
        {
            await h.Host.dispose()
        }
    })

    test('two rapid saves upgrade once to the latest', async () =>
    {
        const h = new HostFx()
        try
        {
            const engine = await h.Host.Engine()
            h.Save(HostFx.Cy)
            h.Save(HostFx.Di)
            await h.Settle()
            assert.equal(h.Changes, 1)
            assert.deepEqual(await HostFx.NamesIn(engine), ['Bo', 'Di'])
        }
        finally
        {
            await h.Host.dispose()
        }
    })

    test('dispose disposes the engine', async () =>
    {
        const h = new HostFx()
        const engine = await h.Host.Engine()
        h.Save(HostFx.Cy)
        await h.Host.dispose()
        assert.equal(h.Timer.Armed, false, 'the pending debounce is cancelled')
        assert.equal(h.Fx.Lang.GraphChanged.subscriberCount, 0)
        await assert.rejects(engine.BeginRead(AccessScope.System), (error: unknown) => error instanceof GraphError && error.GraphCode === GraphErrorCode.Disposed)
        await assert.rejects(h.Host.Engine())
        await h.Host.dispose()
    })

    test('upgrade failure keeps the previous engine data', async () =>
    {
        const h = new HostFx()
        try
        {
            const engine = await h.Host.Engine()
            const before = engine.SchemaVersion
            h.Save(HostFx.Broken)
            await h.Settle()
            assert.equal(h.Diagnostics.Failures.length, 1)
            assert.ok(h.Diagnostics.Failures[0] instanceof DevSnapshotCompileError, String(h.Diagnostics.Failures[0]))
            assert.equal(engine.SchemaVersion, before)
            assert.deepEqual(await HostFx.NamesIn(engine), ['Ada', 'Bo'])

            h.Fx.Lang.ResolveFailure = new Error(HostFx.ResolveMessage)
            h.Save(HostFx.Cy)
            await h.Settle()
            assert.equal(h.Diagnostics.Failures.length, 2)
            assert.equal(engine.SchemaVersion, before)
            assert.equal(h.Changes, 0)

            h.Fx.Lang.ResolveFailure = undefined
            h.Fx.Lang.RaiseGraphChanged()
            await h.Settle()
            assert.equal(h.Changes, 1, 'the next change retries')
            assert.deepEqual(await HostFx.NamesIn(engine), ['Bo', 'Cy'])
        }
        finally
        {
            await h.Host.dispose()
        }
    })

    test('an upgrade arriving during a commit waits for it and never lands torn', async () =>
    {
        const h = new HostFx()
        try
        {
            const engine = await h.Host.Engine()
            let raised = false
            h.Fx.Lang.OnIdle = () =>
            {
                if (raised) return
                // the first file of the two-file commit is on disk; the second is not
                raised = true
                h.Fx.Lang.RaiseGraphChanged()
                h.Timer.Fire()
            }
            await new Cypher.CypherEngine(engine).Execute(AccessScope.System, HostFx.RenameBoth)
            await h.Host.WhenUpgraded()
            assert.ok(raised)
            const committed = await new DevSnapshotSource(h.Fx.Source, h.Fx.Lang).Current()
            assert.equal(engine.SchemaVersion, committed.Description.Version)
            assert.equal(h.Changes, 1)
            assert.deepEqual(await HostFx.NamesIn(engine), ['Ann', 'Bea'])
            assert.deepEqual(h.Diagnostics.Failures, [])
        }
        finally
        {
            await h.Host.dispose()
        }
    })

    test('no solution open is an empty engine that upgrades once one opens', async () =>
    {
        const h = new HostFx()
        const solution = h.Fx.Solution
        h.Fx.Solution = undefined
        try
        {
            const engine = await h.Host.Engine()
            const empty = await h.Host.Description()
            assert.deepEqual(empty.Seed, [], 'no solution seeds no instances')
            assert.equal((await h.Host.Repository()).has(EngineHostFx.C1), false)
            h.Fx.Solution = solution
            h.Fx.Lang.RaiseGraphChanged()
            await h.Settle()
            assert.equal(h.Changes, 1)
            assert.deepEqual(await HostFx.NamesIn(engine), ['Ada', 'Bo'])
        }
        finally
        {
            await h.Host.dispose()
        }
    })

    test('a throwing Changed subscriber is reported and never stalls later upgrades', async () =>
    {
        const h = new HostFx()
        h.Host.Changed.Subscribe(() => { throw new Error(HostFx.SubscriberMessage) })
        const engine = await h.Host.Engine()
        h.Save(HostFx.Cy)
        await h.Settle()
        assert.equal(h.Diagnostics.HandlerFailures.length, 1)
        assert.deepEqual(await HostFx.NamesIn(engine), ['Bo', 'Cy'])
        h.Save(HostFx.Di)
        await h.Settle()
        assert.equal(h.Diagnostics.HandlerFailures.length, 2)
        assert.deepEqual(await HostFx.NamesIn(engine), ['Bo', 'Di'], 'the next save still upgrades')
        assert.deepEqual(h.Diagnostics.Failures, [])
        await h.Host.dispose()
        await assert.rejects(engine.BeginRead(AccessScope.System), (error: unknown) => error instanceof GraphError && error.GraphCode === GraphErrorCode.Disposed)
    })

    test('two models of one namespace: successive engine writes both upgrade, declared ids kept', async () =>
    {
        const h = new HostFx()
        try
        {
            const engine = await h.Host.Engine()
            await h.Write(engine, HostFx.RenameAda)
            assert.equal(h.Changes, 1)
            await h.Write(engine, HostFx.RenameBo)
            assert.equal(h.Changes, 2)
            assert.deepEqual(h.Diagnostics.Failures, [])
            assert.match(h.Fx.A.Files.get(EngineHostFx.File)!, HostFx.ModelM)
            assert.match(h.Fx.B.Files.get(EngineHostFx.File)!, HostFx.ModelN)
            assert.deepEqual(await HostFx.NamesIn(engine), ['Ann', 'Bea'])
            const owners = (await h.Host.Description()).Seed.filter(n => n.PublicId === EngineHostFx.C1 || n.PublicId === EngineHostFx.C2).map(n => n.Owner).sort()
            assert.deepEqual(owners, [EngineHostFx.ModelM, EngineHostFx.ModelN])
        }
        finally
        {
            await h.Host.dispose()
        }
    })

    test('a real engine write leaves flight once the engine finalizes (CommitApplied), so WhenWritesSettled resolves', async () =>
    {
        const h = new HostFx()
        try
        {
            const engine = await h.Host.Engine()
            await h.Write(engine, HostFx.RenameAda)
            assert.equal(await Settles.Yet(h.Host.WhenWritesSettled()), true)
        }
        finally
        {
            await h.Host.dispose()
        }
    })
})

describe('EngineWriteTracker (M1: settle after the engine finalizes)', () =>
{
    test('a committed transaction stays in flight until Finalized', async () =>
    {
        const tracker = new EngineWriteTracker()
        const transaction = await tracker.Track(new InertConnector()).Begin()
        await transaction.Commit()
        assert.equal(await Settles.Yet(tracker.Settled()), false, 'the connector committed, the engine has not finalized')
        assert.equal(tracker.Quiet(tracker.Begun), false)
        const settled = tracker.Settled()
        tracker.Finalized()
        assert.equal(await Settles.Yet(settled), true)
        assert.equal(tracker.Quiet(tracker.Begun), true)
    })

    test('a committed transaction reverted before Finalize (a failed Finalize or a timeout) leaves flight after its revert', async () =>
    {
        const tracker = new EngineWriteTracker()
        const transaction = await tracker.Track(new InertConnector()).Begin()
        await transaction.Commit()
        await transaction.Revert()
        assert.equal(await Settles.Yet(tracker.Settled()), true)
        // a later Finalized for another commit never exits twice
        tracker.Finalized()
        assert.equal(tracker.Quiet(tracker.Begun), true)
    })

    test('a revert after Finalized compensates in flight and leaves again', async () =>
    {
        const tracker = new EngineWriteTracker()
        const transaction = await tracker.Track(new InertConnector()).Begin()
        await transaction.Commit()
        tracker.Finalized()
        await transaction.Revert()
        assert.equal(tracker.Quiet(tracker.Begun), true)
    })
})
