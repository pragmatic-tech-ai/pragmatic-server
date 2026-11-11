import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessDefault, AccessScope, Compare, CompareOp, Cypher, Not } from '@pragmatic-tech-ai/graph'
import type { GraphEngine } from '@pragmatic-tech-ai/graph'
import { ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DataSourceAdapterCatalog } from '@pragmatic-tech-ai/todl'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { DevGraphEngineHost } from '../dev-graph-engine-host.js'
import { EngineHostFx, FakeSolution, HeldFence, ManualTimer, MemoryStorage } from './engine-host-fixture.js'
import { MemorySourceAdapterFactory } from './memory-source-adapter.js'

/**
 * The two-member shop fixture plus member `c` declaring crm.Customer, the `crm` SQL datasource and model crm.App
 * populating crm.Customer from it (source `Customer`, key `cust_id`, name in `nm`). The datasource is served by a
 * MemorySourceAdapter registered for the SQL kind.
 */
class ExternalFx
{
    public static readonly Root = 'mem/c'
    public static readonly File = 'crm.todl'
    public static readonly Customer = 'crm.Customer'
    public static readonly Source = 'Customer'
    public static readonly Key = 'cust_id'
    public static readonly NameField = 'nm'
    public static readonly Acme = 'Acme'
    public static readonly Bolt = 'Bolt'
    public static readonly Engine = 'crm@connector:crm'
    public static readonly Names = 'MATCH (c:`crm.Customer`) RETURN c.name AS name ORDER BY name'
    public static readonly ShopNames = 'MATCH (n:shop.Customer) RETURN n.name AS name ORDER BY name'
    public static readonly Bound = 'namespace crm {\n  concept Customer { name : string?; }\n  datasource crm { kind = sql; connection = "crm-db"; }\n  model App : crm { connect crm; populate Customer key cust_id { name = "nm"; } }\n}\n'
    public static readonly Unbound = 'namespace crm {\n  concept Customer { name : string?; }\n  model App : crm { }\n}\n'
    /** A second model of the solution binding crm.Customer to the same source: their external ids would collide. */
    public static readonly Colliding = 'namespace crm {\n  model Other : crm { connect crm; populate Customer key cust_id { name = "nm"; } }\n}\n'
    public static readonly CollidingFile = 'other.todl'
    public static readonly Collision = /both bind "crm\.Customer" to source "Customer"/

    public readonly Fx = new EngineHostFx()
    public readonly C: MemoryStorage
    public readonly Factory = new MemorySourceAdapterFactory()
    public readonly Timer = new ManualTimer()
    public readonly Host: DevGraphEngineHost

    public constructor(source: string = ExternalFx.Bound)
    {
        this.C = new MemoryStorage(ExternalFx.Root, { [ExternalFx.File]: source })
        this.Fx.Solution = new FakeSolution(EngineHostFx.SolutionName, [{ Storage: this.Fx.A }, { Storage: this.Fx.B }, { Storage: this.C }])
        this.Factory.Adapter.Seed(ExternalFx.Source, [
            { [ExternalFx.Key]: '1', [ExternalFx.NameField]: ExternalFx.Acme },
            { [ExternalFx.Key]: '2', [ExternalFx.NameField]: ExternalFx.Bolt },
        ])
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, new DataSourceAdapterCatalog().Register(this.Factory))
        this.Host = new DevGraphEngineHost(this.Fx.Source, () => Promise.resolve(this.Fx.Lang), this.Timer, undefined, undefined, undefined, undefined, () => services)
        this.Host.InstallWriteFence(HeldFence.Instance)
    }

    /** Saves `text` as `file` of member c, raises the change and lets the upgrade pass run. */
    public async Save(text: string, file: string = ExternalFx.File): Promise<void>
    {
        this.C.Files.set(file, text)
        this.Fx.Lang.RaiseGraphChanged()
        this.Timer.FireAll()
        await this.Host.WhenUpgraded()
    }

    public static async Strings(engine: GraphEngine, statement: string, scope: AccessScope = AccessScope.System): Promise<unknown[]>
    {
        const result = await new Cypher.CypherEngine(engine).Execute(scope, statement)
        return result.Rows.map(row => (row[0] as Cypher.ScalarValue).Value)
    }

    public static IsInvalidRequest(error: unknown): boolean
    {
        return error instanceof ResponseError && error.code === ErrorCodes.InvalidRequest && ExternalFx.Collision.test(error.message)
    }
}

describe('dev external bindings', () =>
{
    test('dev cypher reads an external binding', async () =>
    {
        const x = new ExternalFx()
        try
        {
            const engine = await x.Host.Engine()
            assert.deepEqual(await ExternalFx.Strings(engine, ExternalFx.Names), [ExternalFx.Acme, ExternalFx.Bolt])
            assert.deepEqual(await ExternalFx.Strings(engine, ExternalFx.Names), [ExternalFx.Acme, ExternalFx.Bolt])
            assert.equal(x.Factory.Adapter.Requests.length, 2, 'each query reads the source: nothing is cached across queries')
            // the external concept is no longer file-bound: the description binds it to the plan's engine connector
            const snapshot = await x.Host.Snapshot()
            assert.deepEqual(snapshot.Connectors.map(plan => plan.Name), [ExternalFx.Engine])
            assert.ok(snapshot.Description.Bindings.some(binding => binding.Concept === ExternalFx.Customer && binding.Connector === ExternalFx.Engine))
            assert.ok(snapshot.External.has(ExternalFx.Customer))
            assert.deepEqual(snapshot.Identity?.Bindings().map(binding => binding.Binding.Concept), [ExternalFx.Customer])
        }
        finally
        {
            await x.Host.dispose()
        }
    })

    test('dev scope filters fetched rows', async () =>
    {
        const x = new ExternalFx()
        try
        {
            const engine = await x.Host.Engine()
            // a source that ignores whatever is pushed down: the engine must re-check every row it fetches
            x.Factory.Adapter.IgnoreWhere = true
            const rows = new Map([[ExternalFx.Customer, new Not(new Compare('name', CompareOp.Eq, ExternalFx.Acme))]])
            const scope = AccessScope.Build({ Default: AccessDefault.Allow, Rows: rows })
            assert.deepEqual(await ExternalFx.Strings(engine, ExternalFx.Names, scope), [ExternalFx.Bolt])
        }
        finally
        {
            await x.Host.dispose()
        }
    })

    test('adding a connector reopens the engine', async () =>
    {
        const x = new ExternalFx(ExternalFx.Unbound)
        try
        {
            const before = await x.Host.Engine()
            assert.deepEqual((await x.Host.Snapshot()).Connectors, [])
            let changes = 0
            x.Host.Changed.Subscribe(() => { changes += 1 })
            await x.Save(ExternalFx.Bound)
            const after = await x.Host.Engine()
            assert.notEqual(after, before, 'the engine connectors are fixed at Open: a new connector set reopens')
            assert.equal(changes, 1)
            assert.deepEqual(await ExternalFx.Strings(after, ExternalFx.Names), [ExternalFx.Acme, ExternalFx.Bolt])
            assert.deepEqual(await ExternalFx.Strings(after, ExternalFx.ShopNames), ['Ada', 'Bo'], 'the .todl seed data is still there')
            // a reader handed out before the reopen still finishes on the retired engine
            assert.deepEqual(await ExternalFx.Strings(before, ExternalFx.ShopNames), ['Ada', 'Bo'])
            // an unchanged connector set upgrades in place
            x.Fx.A.Files.set(EngineHostFx.File, EngineHostFx.SourceA.replace('Ada', 'Cy'))
            await x.Save(ExternalFx.Bound)
            assert.equal(await x.Host.Engine(), after)
            assert.equal(changes, 2)
            assert.deepEqual(await ExternalFx.Strings(after, ExternalFx.ShopNames), ['Bo', 'Cy'])
        }
        finally
        {
            await x.Host.dispose()
        }
    })

    test('conflicting dev connector specs fail the snapshot', async () =>
    {
        const x = new ExternalFx()
        try
        {
            await x.Host.Engine()
            await x.Save(ExternalFx.Colliding, ExternalFx.CollidingFile)
            await assert.rejects(x.Host.Engine(), (error: unknown) => ExternalFx.IsInvalidRequest(error))
            await assert.rejects(x.Host.Snapshot(), (error: unknown) => ExternalFx.IsInvalidRequest(error))
            // the next save that describes clears the failure
            x.C.Files.delete(ExternalFx.CollidingFile)
            await x.Save(ExternalFx.Bound)
            assert.deepEqual(await ExternalFx.Strings(await x.Host.Engine(), ExternalFx.Names), [ExternalFx.Acme, ExternalFx.Bolt])
        }
        finally
        {
            await x.Host.dispose()
        }
    })

    test('a failing snapshot fails the open with the same request error', async () =>
    {
        const x = new ExternalFx()
        x.C.Files.set(ExternalFx.CollidingFile, ExternalFx.Colliding)
        try
        {
            await assert.rejects(x.Host.Engine(), (error: unknown) => ExternalFx.IsInvalidRequest(error))
        }
        finally
        {
            await x.Host.dispose()
        }
    })
})
