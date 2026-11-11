import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessScope, ConnectorError, Cypher, GraphError, GraphErrorCode, StorageKind } from '@pragmatic-tech-ai/graph'
import type { GraphEngine, IGraphEngineOptions } from '@pragmatic-tech-ai/graph'
import { WriteFailureKind } from '@pragmatic-tech-ai/todl'
import type { WriteBatch, WriteResult } from '@pragmatic-tech-ai/todl'
import { DeliveryChannel, EngineBridgeErrorCode, EnvironmentCatalogError, EnvironmentCatalogErrorCode, ExternalWriteError } from '@pragmatic-tech-ai/todl/engine'
import type { IStorage, StorageEntry } from '@pragmatic-tech-ai/todl-runtime'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { InMemoryTenantCoordinator } from '../../../tenancy/tenant-coordinator.js'
import { InMemoryTenantProvisioning, TenantRegistry } from '../../../tenancy/tenant-registry.js'
import { MemorySourceAdapter } from '../../engine/tests/memory-source-adapter.js'
import { EnvironmentEngineHost, EnvironmentUpgradeFailedError } from '../environment-engine-host.js'
import type { IEnvironmentDiagnostics } from '../environment-engine-host.js'
import { EnvironmentFixture } from './environment-fixture.js'

/**
 * Records every diagnostic; `OnRetry` runs on each locked-open retry (`Released` is its latest result, which a
 * ReleaseAwaitingHost awaits before the next attempt), `Reverted` resolves on the first RevertFailed.
 */
class RecordingDiagnostics implements IEnvironmentDiagnostics
{
    public readonly Upgrades: unknown[] = []
    public readonly Handlers: unknown[] = []
    public readonly Reverts: ConnectorError[] = []
    public readonly Retries: number[] = []
    public OnRetry: () => Promise<void> | void = () => undefined
    public Released: Promise<void> = Promise.resolve()
    public readonly Reverted: Promise<void>
    private reverted: () => void = () => undefined

    public constructor()
    {
        this.Reverted = new Promise<void>(resolve => { this.reverted = resolve })
    }

    public UpgradeFailed(error: unknown): void
    {
        this.Upgrades.push(error)
    }

    public ChangedHandlerFailed(error: unknown): void
    {
        this.Handlers.push(error)
    }

    public RevertFailed(error: ConnectorError): void
    {
        this.Reverts.push(error)
        this.reverted()
    }

    public OpenRetried(_error: unknown, attempt: number): void
    {
        this.Retries.push(attempt)
        this.Released = Promise.resolve(this.OnRetry())
    }

    public DrainUnsettled(): void
    {
    }
}

/** A host whose next engine open fails (`FailNextOpen`), as a reopen whose store cannot be opened. */
class FailingOpenHost extends EnvironmentEngineHost
{
    private static readonly FailureMessage = 'the store could not be opened'
    public FailNextOpen = false

    protected override OpenEngine(options: IGraphEngineOptions): Promise<GraphEngine>
    {
        if (!this.FailNextOpen) return super.OpenEngine(options)
        this.FailNextOpen = false
        return Promise.reject(new Error(FailingOpenHost.FailureMessage))
    }
}

/** A host whose every engine open first waits for the diagnostics' `Released` (the previous holder's store release). */
class ReleaseAwaitingHost extends EnvironmentEngineHost
{
    public constructor(private readonly recording: RecordingDiagnostics, fx: EnvironmentFixture)
    {
        super(fx.Deliveries(), new NodeFsStorage(fx.PackagesDir), fx.Services(), { Kind: StorageKind.Lmdb, Path: fx.StorePath }, recording, { OpenBackoffMs: 1 })
    }

    protected override async OpenEngine(options: IGraphEngineOptions): Promise<GraphEngine>
    {
        await this.recording.Released
        return super.OpenEngine(options)
    }
}

/** Package storage whose reads fail while `Failing` is set (a redelivery that cannot read the packages). */
class FlakyStorage implements IStorage
{
    private static readonly FailureMessage = 'package storage is unavailable'
    public Failing = false

    public constructor(private readonly inner: IStorage)
    {
    }

    public get Root(): string
    {
        return this.inner.Root
    }

    public ReadText(path: string): Promise<string>
    {
        return this.Failing ? Promise.reject(new Error(FlakyStorage.FailureMessage)) : this.inner.ReadText(path)
    }

    public ReadBytes(path: string): Promise<Uint8Array>
    {
        return this.inner.ReadBytes(path)
    }

    public WriteText(path: string, content: string): Promise<void>
    {
        return this.inner.WriteText(path, content)
    }

    public WriteBytes(path: string, bytes: Uint8Array): Promise<void>
    {
        return this.inner.WriteBytes(path, bytes)
    }

    public Exists(path: string): Promise<boolean>
    {
        return this.inner.Exists(path)
    }

    public Delete(path: string): Promise<void>
    {
        return this.inner.Delete(path)
    }

    public CreateDirectory(path: string): Promise<void>
    {
        return this.inner.CreateDirectory(path)
    }

    public Rename(from: string, to: string): Promise<void>
    {
        return this.inner.Rename(from, to)
    }

    public List(path: string): Promise<readonly StorageEntry[]>
    {
        return this.inner.List(path)
    }
}

/**
 * A source whose next Apply hangs until `Release()` and then applies; every Apply after that one reports each operation
 * as failed (so the compensation of the released write fails).
 */
class HangingSourceAdapter extends MemorySourceAdapter
{
    private gate: Promise<void> | undefined
    private open: () => void = () => undefined
    private released = false

    public HangNext(): void
    {
        this.gate = new Promise<void>(resolve => { this.open = resolve })
    }

    public Release(): void
    {
        this.open()
    }

    public override async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        if (this.released)
        {
            this.FailNext(WriteFailureKind.Error)
            return super.Apply(batch)
        }
        const gate = this.gate
        if (gate === undefined) return super.Apply(batch)
        this.gate = undefined
        await gate
        this.released = true
        return super.Apply(batch)
    }
}

class HostFx
{
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly CrmMajor = { id: 'crm', version: '2.0.0' }
    public static readonly Notes = { id: 'notes', version: '1.0.0' }
    public static readonly Ext = { id: 'ext', version: '1.0.0' }
    public static readonly Ref = { id: 'ref', version: '1.0.0' }
    public static readonly AppVersion = '1.0.0'
    public static readonly CrmApp = 'crm-app'
    public static readonly NotesApp = 'notes-app'
    public static readonly ExtApp = 'ext-app'
    public static readonly OtherApp = 'other-app'
    public static readonly PromoteSet = 'ref-set'
    public static readonly Persisted = 'persisted'
    public static readonly Code = 'ref.Code'
    public static readonly RowKey = '1'
    public static readonly LateKey = '9'
    public static readonly NameMember = 'name'
    public static readonly LateName = 'late'
    public static readonly Account = 'crm.Account'
    public static readonly Note = 'notes.Note'
    public static readonly Customer = 'ext.Customer'
    public static readonly ShareGrant = 'todl.system.ShareGrant'
    public static readonly SystemModel = 'todl.system'
    public static readonly AccountId = 'acc-1'
    public static readonly Acme = 'Acme'
    public static readonly Source = 'Customer'
    public static readonly Key = 'cust_id'
    public static readonly NameField = 'nm'
    public static readonly Accounts = 'MATCH (a:`crm.Account`) RETURN a.name AS name'
    public static readonly Customers = 'MATCH (c:`ext.Customer`) RETURN c.name AS name ORDER BY name'
    public static readonly CrmTodl = 'namespace crm {\n  concept Account { name : string?; }\n  model Crm : crm { }\n}\n'
    public static readonly CrmMajorTodl = 'namespace crm {\n  concept Account { name : string?; code : string?; }\n  model Crm : crm { }\n}\n'
    public static readonly RefTodl = 'namespace ref {\n  concept Code { name : string?; }\n  model Ref : ref { }\n}\n'
    public static readonly NotesTodl = 'namespace notes {\n  concept Note { text : string?; }\n  model Notes : notes { }\n}\n'
    public static readonly ExtTodl = 'namespace ext {\n  concept Customer { name : string?; }\n  datasource src { kind = sql; connection = "ext-db"; }\n  model Ext : ext { connect src; populate Customer key cust_id { name = "nm"; } }\n}\n'

    /** The fixture with crm, notes and ext compiled (and crm@2.0.0 when `major`); the ext source holds one row. */
    public static async Run(body: (fx: EnvironmentFixture) => Promise<void>, adapter?: MemorySourceAdapter): Promise<void>
    {
        const fx = new EnvironmentFixture(adapter)
        try
        {
            await fx.Package(HostFx.Crm.id, HostFx.Crm.version, HostFx.CrmTodl)
            await fx.Package(HostFx.CrmMajor.id, HostFx.CrmMajor.version, HostFx.CrmMajorTodl)
            await fx.Package(HostFx.Notes.id, HostFx.Notes.version, HostFx.NotesTodl)
            await fx.Package(HostFx.Ext.id, HostFx.Ext.version, HostFx.ExtTodl)
            await fx.Package(HostFx.Ref.id, HostFx.Ref.version, HostFx.RefTodl)
            fx.Source.Adapter.Seed(HostFx.Source, [{ [HostFx.Key]: HostFx.RowKey, [HostFx.NameField]: HostFx.Acme }])
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    /** Delivers `app` (its package `ref`) through `host`, the persist step making it live. */
    public static Deploy(fx: EnvironmentFixture, host: EnvironmentEngineHost, app: string, ref: { id: string; version: string }): Promise<void>
    {
        return host.Deliver({ Channel: DeliveryChannel.Deploy, Name: app, Packages: [{ model: ref.id, version: ref.version }] },
            async () => fx.Live(app, HostFx.AppVersion, [ref]))
    }

    public static Definitions(description: { Definitions: readonly { Name: string }[] }): string[]
    {
        return description.Definitions.map(definition => definition.Name)
    }

    public static async Column(engine: GraphEngine, query: string): Promise<unknown[]>
    {
        const result = await new Cypher.CypherEngine(engine).Execute(AccessScope.System, query)
        return result.Rows.map(row => (row[0] as Cypher.ScalarValue).Value)
    }

    public static async SnapshotCommit(engine: GraphEngine): Promise<bigint>
    {
        const reader = await engine.BeginRead(AccessScope.System)
        try
        {
            return reader.SnapshotCommit
        }
        finally
        {
            reader.dispose()
        }
    }

    public static IsDisposed(error: unknown): boolean
    {
        return error instanceof GraphError && error.GraphCode === GraphErrorCode.Disposed
    }

    public static IsLocked(error: unknown): boolean
    {
        return error instanceof GraphError && error.GraphCode === GraphErrorCode.Locked
    }
}

describe('environment engine host', () =>
{
    test('opens with only the system package when nothing is delivered', async () =>
    {
        await HostFx.Run(async fx =>
        {
            const host = fx.Host()
            assert.ok(HostFx.Definitions(await host.Description()).includes(HostFx.ShareGrant))
            const snapshot = await host.Snapshot()
            assert.deepEqual(snapshot.Models, [], 'todl.system is not a query model')
            assert.deepEqual(snapshot.Deliveries, [])
            assert.deepEqual(snapshot.Catalog.Packages.map(ref => ref.model), [HostFx.SystemModel])
        })
    })

    test('catalog fields reach the engine', async () =>
    {
        await HostFx.Run(async fx =>
        {
            fx.Live(HostFx.CrmApp, HostFx.AppVersion, [HostFx.Crm])
            fx.Live(HostFx.ExtApp, HostFx.AppVersion, [HostFx.Ext])
            await fx.Promote(HostFx.PromoteSet, [HostFx.Ref])
            const host = fx.Host()
            const engine = await host.Engine()
            const snapshot = await host.Snapshot()
            const catalog = snapshot.Catalog
            assert.equal(catalog.HomeModels.get(HostFx.ShareGrant), HostFx.SystemModel)
            assert.equal(catalog.HomeModels.get(HostFx.Account), HostFx.Crm.id)
            assert.equal(snapshot.Description, catalog.Description)
            assert.equal(snapshot.Identity, catalog.Identity)
            assert.equal(snapshot.Connectors, catalog.Connectors)
            assert.deepEqual(snapshot.Models, [HostFx.Crm.id, HostFx.Ext.id, HostFx.Ref.id])
            assert.ok(HostFx.Definitions(await host.Description()).includes(HostFx.Code), 'the promote set joins the union')
            assert.deepEqual(snapshot.Deliveries.map(delivery => delivery.Name), [HostFx.CrmApp, HostFx.ExtApp, HostFx.PromoteSet])
            assert.equal(engine.SchemaVersion, catalog.Description.Version)
            assert.equal(catalog.Connectors.length, 1)
            assert.deepEqual([...engine.ExternalConnectors().keys()], catalog.Connectors.map(plan => plan.Name), 'one connector per catalog plan, by Name')
            assert.deepEqual(await HostFx.Column(engine, HostFx.Customers), [HostFx.Acme], 'the external binding reads its source')
        })
    })

    test('deliver validates before persisting', async () =>
    {
        await HostFx.Run(async fx =>
        {
            fx.Live(HostFx.CrmApp, HostFx.AppVersion, [HostFx.Crm])
            const host = fx.Host()
            const engine = await host.Engine()
            const version = engine.SchemaVersion
            let persisted = false
            const change = { Channel: DeliveryChannel.Deploy, Name: HostFx.OtherApp, Packages: [{ model: HostFx.CrmMajor.id, version: HostFx.CrmMajor.version }] }
            await assert.rejects(host.Deliver(change, async () => { persisted = true }),
                (error: unknown) => error instanceof EnvironmentCatalogError && error.Code === EnvironmentCatalogErrorCode.IncompatibleVersions)
            assert.equal(persisted, false, 'persist never runs for an invalid delivery set')
            assert.equal(await host.Engine(), engine)
            assert.equal(engine.SchemaVersion, version, 'the engine is unchanged')
        })
    })

    test('new connector reopens on the same store', async () =>
    {
        await HostFx.Run(async fx =>
        {
            fx.Live(HostFx.CrmApp, HostFx.AppVersion, [HostFx.Crm])
            const host = fx.Host()
            let changes = 0
            host.Changed.Subscribe(() => { changes++ })
            const first = await host.Engine()
            await fx.Seed([{ Concept: HostFx.Account, Id: HostFx.AccountId, Properties: { name: HostFx.Acme } }], host)
            // the same (empty) connector set: upgraded in place
            await HostFx.Deploy(fx, host, HostFx.NotesApp, HostFx.Notes)
            assert.equal(await host.Engine(), first, 'same connector set: the same engine')
            assert.ok(HostFx.Definitions(await host.Description()).includes(HostFx.Note))
            assert.equal(changes, 1)
            // a new external connector: reopened on the same LMDB path
            await HostFx.Deploy(fx, host, HostFx.ExtApp, HostFx.Ext)
            const second = await host.Engine()
            assert.notEqual(second, first, 'a changed connector set reopens')
            assert.equal(changes, 2)
            await assert.rejects(first.BeginRead(AccessScope.System), (error: unknown) => HostFx.IsDisposed(error), 'the replaced engine is closed')
            assert.deepEqual(await HostFx.Column(second, HostFx.Accounts), [HostFx.Acme], 'committed engine data survives the reopen')
            assert.deepEqual(await HostFx.Column(second, HostFx.Customers), [HostFx.Acme])
        })
    })

    test('a failed reopen recovers on the next call and raises Changed', async () =>
    {
        await HostFx.Run(async fx =>
        {
            fx.Live(HostFx.CrmApp, HostFx.AppVersion, [HostFx.Crm])
            const diagnostics = new RecordingDiagnostics()
            const host = fx.Track(new FailingOpenHost(fx.Deliveries(), new NodeFsStorage(fx.PackagesDir), fx.Services(), { Kind: StorageKind.Lmdb, Path: fx.StorePath }, diagnostics))
            let changes = 0
            host.Changed.Subscribe(() => { changes++ })
            const first = await host.Engine()
            // a new connector reopens; the reopen's open fails after the old engine was closed
            host.FailNextOpen = true
            await assert.rejects(HostFx.Deploy(fx, host, HostFx.ExtApp, HostFx.Ext), EnvironmentUpgradeFailedError)
            assert.equal(changes, 0)
            assert.equal(diagnostics.Upgrades.length, 1)
            const second = await host.Engine()
            assert.notEqual(second, first)
            assert.equal(changes, 1, 'the recovered engine replaces the disposed one: subscribers re-read it')
            assert.deepEqual(await HostFx.Column(second, HostFx.Customers), [HostFx.Acme])
        })
    })

    test('upgrade failure marks stale and the next call retries', async () =>
    {
        await HostFx.Run(async fx =>
        {
            fx.Live(HostFx.CrmApp, HostFx.AppVersion, [HostFx.Crm])
            const diagnostics = new RecordingDiagnostics()
            const packages = new FlakyStorage(new NodeFsStorage(fx.PackagesDir))
            const host = fx.Host(diagnostics, undefined, packages)
            await host.Engine()
            const change = { Channel: DeliveryChannel.Deploy, Name: HostFx.NotesApp, Packages: [{ model: HostFx.Notes.id, version: HostFx.Notes.version }] }
            const persisted = HostFx.Persisted
            await assert.rejects(host.Deliver(change, async () =>
            {
                fx.Live(HostFx.NotesApp, HostFx.AppVersion, [HostFx.Notes])
                // validated already; the redelivery after the persist cannot read the packages
                packages.Failing = true
                return persisted
            }), (error: unknown) => error instanceof EnvironmentUpgradeFailedError && error.Result === persisted)
            assert.equal(diagnostics.Upgrades.length, 1, 'reported once')
            packages.Failing = false
            assert.ok(HostFx.Definitions(await host.Description()).includes(HostFx.Note), 'the next call redelivers before serving')
            assert.equal(diagnostics.Upgrades.length, 1)
        })
    })

    test('lease loss disposes the engine', async () =>
    {
        await HostFx.Run(async fx =>
        {
            fx.Live(HostFx.CrmApp, HostFx.AppVersion, [HostFx.Crm])
            const provisioning = new InMemoryTenantProvisioning(new Map([[EnvironmentFixture.TenantId, { displayName: EnvironmentFixture.TenantId, purpose: TenantPurpose.Runtime }]]))
            const registry = new TenantRegistry(fx.Root, fx.MasterKey(), provisioning, new InMemoryTenantCoordinator())
            try
            {
                const server = await registry.ServerFor(EnvironmentFixture.TenantId)
                const engine = await server.EnvironmentEngine().Engine()
                await fx.Seed([{ Concept: HostFx.Account, Id: HostFx.AccountId, Properties: { name: HostFx.Acme } }], server.EnvironmentEngine())
                await registry.DisposeTenant(EnvironmentFixture.TenantId)
                await assert.rejects(engine.BeginRead(AccessScope.System), (error: unknown) => HostFx.IsDisposed(error), 'the engine is disposed with the server')
                // the store is closed: the next lease holder opens the same LMDB and sees the committed write
                const next = await registry.ServerFor(EnvironmentFixture.TenantId)
                assert.notEqual(next, server)
                assert.deepEqual(await HostFx.Column(await next.EnvironmentEngine().Engine(), HostFx.Accounts), [HostFx.Acme])
            }
            finally
            {
                await registry.DisposeAll()
            }
        })
    })

    test('reopen after restart sees committed data', async () =>
    {
        await HostFx.Run(async fx =>
        {
            fx.Live(HostFx.CrmApp, HostFx.AppVersion, [HostFx.Crm])
            const before = fx.Host()
            const commit = await fx.Seed([{ Concept: HostFx.Account, Id: HostFx.AccountId, Properties: { name: HostFx.Acme } }], before)
            await before.dispose()
            const after = fx.Host()
            const engine = await after.Engine()
            assert.deepEqual(await HostFx.Column(engine, HostFx.Accounts), [HostFx.Acme])
            assert.equal(await HostFx.SnapshotCommit(engine), commit, 'an unchanged description opens without an upgrade commit')
        })
    })

    test('locked store is retried', async () =>
    {
        await HostFx.Run(async fx =>
        {
            const holder = fx.Host()
            await holder.Engine()
            // released after the first attempt: the retry opens
            const released = new RecordingDiagnostics()
            released.OnRetry = () => holder.dispose()
            const next = fx.Track(new ReleaseAwaitingHost(released, fx))
            await next.Engine()
            assert.ok(released.Retries.length >= 1)
            // held throughout: Locked after OpenAttempts
            const held = new RecordingDiagnostics()
            const blocked = fx.Host(held, { OpenBackoffMs: 10 })
            await assert.rejects(blocked.Engine(), (error: unknown) => HostFx.IsLocked(error))
            assert.deepEqual(held.Retries, [1, 2], 'tried OpenAttempts times in all')
            assert.equal(EnvironmentEngineHost.OpenAttempts, 3)
        })
    })

    test('late revert failure is reported', async () =>
    {
        const adapter = new HangingSourceAdapter()
        await HostFx.Run(async fx =>
        {
            fx.Live(HostFx.ExtApp, HostFx.AppVersion, [HostFx.Ext])
            const diagnostics = new RecordingDiagnostics()
            const host = fx.Host(diagnostics, { PrepareTimeoutMs: 200 })
            const engine = await host.Engine()
            const identity = (await host.Snapshot()).Catalog.Identity
            const binding = identity.Bindings()[0]!
            const id = identity.Mint(binding, HostFx.LateKey)
            adapter.HangNext()
            const transaction = await engine.Begin(AccessScope.System)
            transaction.CreateNode(id, HostFx.Customer, { Owner: binding.Model })
            transaction.SetProperty(id, HostFx.NameMember, HostFx.LateName)
            await assert.rejects(transaction.Commit(), ConnectorError, 'the write-through times out: the caller is answered')
            assert.equal(diagnostics.Reverts.length, 0)
            adapter.Release()
            await diagnostics.Reverted
            assert.equal(diagnostics.Reverts.length, 1, 'the late compensation failure is reported once')
            const late = diagnostics.Reverts[0]!
            assert.equal(late.Connector, binding.Connector)
            assert.ok(late.cause instanceof ExternalWriteError && late.cause.Code === EngineBridgeErrorCode.CompensationFailed, 'a compensation failure')
        }, adapter)
    })
})
