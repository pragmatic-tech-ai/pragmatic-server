import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessScope, Cypher, GraphError, GraphErrorCode } from '@pragmatic-tech-ai/graph'
import type { GraphEngine } from '@pragmatic-tech-ai/graph'
import { Disposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { DevGraphEngineHost, DevSnapshotCompileError } from '../dev-graph-engine-host.js'
import type { IDevEngineDiagnostics, IUpgradeTimer } from '../dev-graph-engine-host.js'
import { DevSnapshotSource } from '../dev-snapshot-source.js'
import { EngineHostFx, FakeSolution, MemoryStorage } from './engine-host-fixture.js'

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

    public UpgradeFailed(error: unknown): void
    {
        this.Failures.push(error)
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
    /**
     * Two members whose model names survive the draft round-trip (it re-emits a model as `<namespace>Model`), so a
     * committed write recompiles cleanly: shop.shopModel holds c1 Ada, crm.crmModel holds c2 Bo.
     */
    public static readonly StableA = 'namespace shop {\n  model shopModel : shop {\n    Customer c1 { name = "Ada"; }\n  }\n}\n'
    public static readonly StableB = 'namespace crm {\n  model crmModel : shop {\n    shop.Customer c2 { name = "Bo"; }\n  }\n}\n'

    public readonly Fx = new EngineHostFx()
    public readonly Timer = new ManualUpgradeTimer()
    public readonly Diagnostics = new RecordingDiagnostics()
    public readonly Host = new DevGraphEngineHost(this.Fx.Source, () => Promise.resolve(this.Fx.Lang), this.Timer, this.Diagnostics)
    public Changes = 0

    public constructor()
    {
        this.Host.Changed.Subscribe(() => { this.Changes += 1 })
    }

    /** Saves member a's file and raises the language service's change, as a real save does. */
    public Save(text: string): void
    {
        this.Fx.A.Files.set(EngineHostFx.File, text)
        this.Fx.Lang.RaiseGraphChanged()
    }

    /** Replaces the solution with the two round-trip-stable members. */
    public UseStableModels(): void
    {
        const a = new MemoryStorage(EngineHostFx.RootA, { [EngineHostFx.File]: HostFx.StableA })
        const b = new MemoryStorage(EngineHostFx.RootB, { [EngineHostFx.File]: HostFx.StableB })
        this.Fx.Solution = new FakeSolution(EngineHostFx.SolutionName, [{ Storage: a }, { Storage: b }])
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
        h.UseStableModels()
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
            assert.deepEqual(await HostFx.NamesIn(engine).catch(() => []), [])
            h.Fx.Solution = solution
            h.Fx.Lang.RaiseGraphChanged()
            await h.Settle()
            assert.deepEqual(await HostFx.NamesIn(engine), ['Ada', 'Bo'])
        }
        finally
        {
            await h.Host.dispose()
        }
    })
})
