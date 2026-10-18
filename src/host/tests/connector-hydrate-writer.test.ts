import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DataSourceKind, WriteConcurrency, WriteAtomicity, WriteFailureKind, WriteOperationKind } from '@pragmatic-tech-ai/todl'
import type { ConnectorBinding, ConnectorSpec, IDataSourceAdapter, IInstanceView, ModelConnectorPlan, QueryRequest, WriteBatch, WriteResult, ExternalRecord } from '@pragmatic-tech-ai/todl'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import { AppWriteStatus, ConnectorWriteOp } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ConnectorWriteOpDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ConnectorHydrateWriter } from '../connector-hydrate-writer.js'
import type { IHydrateAuthorization } from '../connector-hydrate-writer.js'
import { KeyedWriteTargetSource } from '../keyed-write-target-source.js'
import type { IWriteInstanceGate } from '../cypher/write-instance-gate.js'
import type { IWriteTargetSource } from '../write-target-source.js'

class FakeAdapter implements IDataSourceAdapter
{
    public readonly Queries: QueryRequest[] = []
    public readonly Batches: WriteBatch[] = []
    public Failure: WriteFailureKind | undefined
    public Throw = false
    public Custom: WriteResult | undefined
    public readonly Rows: ExternalRecord[]

    public constructor(rows: ExternalRecord[])
    {
        this.Rows = rows
    }

    public Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        this.Queries.push(request)
        const where = request.Where?.All[0]
        return Promise.resolve(where === undefined ? this.Rows : this.Rows.filter(r => String(r[where.Field]) === String(where.Value)))
    }

    public Apply(batch: WriteBatch): Promise<WriteResult>
    {
        this.Batches.push(batch)
        if (this.Throw)
        {
            return Promise.reject(new Error('secret-conn-string'))
        }
        if (this.Custom !== undefined)
        {
            return Promise.resolve(this.Custom)
        }
        if (this.Failure !== undefined)
        {
            return Promise.resolve({ Applied: 0, Failures: batch.Operations.map(o => ({ Key: o.Key, Kind: this.Failure!, Reason: 'nope' })) })
        }
        const failures = batch.Operations.filter(o => batch.VersionField !== undefined && this.Rows.find(r => String(r[batch.IdKey]) === String(o.Key))?.[batch.VersionField] !== o.Version)
            .map(o => ({ Key: o.Key, Kind: WriteFailureKind.Conflict, Reason: 'stale' }))
        return Promise.resolve({ Applied: batch.Operations.length - failures.length, Failures: failures })
    }

    public Dispose(): Promise<void>
    {
        return Promise.resolve()
    }
}

class Opener
{
    public readonly Opened: string[] = []
    public readonly Adapters = new Map<string, FakeAdapter>()

    public OpenAdapter(spec: ConnectorSpec): Promise<IDataSourceAdapter>
    {
        this.Opened.push(spec.Name)
        return Promise.resolve(this.Adapters.get(spec.Name)!)
    }
}

class Fx
{
    public static Binding(concept: string, connector: string, extra: Partial<ConnectorBinding> = {}): ConnectorBinding
    {
        return { Concept: concept, Connector: connector, Source: 'T', IdKey: 'id', FieldMap: { name: 'name' }, Writable: true, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential, ...extra }
    }

    public static Plan(bindings: ConnectorBinding[]): ModelConnectorPlan
    {
        const names = [...new Set(bindings.map(b => b.Connector))]
        return { Model: 'm', Version: '1', Connectors: names.map(n => ({ Name: n, Kind: DataSourceKind.Sql, Config: { password: 'sekret' } }) as unknown as ConnectorSpec), Bindings: bindings }
    }

    public static Op(op: Partial<ConnectorWriteOpDto> = {}): ConnectorWriteOpDto
    {
        return { op: ConnectorWriteOp.Upsert, concept: 'Customer', connector: 'a', source: 'T', key: 'C1', fields: { name: 'New' }, ...op }
    }

    public static World(binding: ConnectorBinding = Fx.Binding('Customer', 'a')): { opener: Opener; a: FakeAdapter; b: FakeAdapter; plan: ModelConnectorPlan }
    {
        const opener = new Opener()
        const a = new FakeAdapter([{ id: 'C1', name: 'Old', ver: 1 }, { id: 'C2', name: 'Two', ver: 1 }])
        const b = new FakeAdapter([{ id: 'O1', name: 'order' }])
        opener.Adapters.set('a', a)
        opener.Adapters.set('b', b)
        return { opener, a, b, plan: Fx.Plan([binding, Fx.Binding('Order', 'b')]) }
    }

    public static Writer(w: { opener: Opener; plan: ModelConnectorPlan }, auth?: IHydrateAuthorization): ConnectorHydrateWriter
    {
        return new ConnectorHydrateWriter(w.plan, w.opener, auth ?? ConnectorHydrateWriter.AllowAll())
    }
}

class KeyedGate implements IWriteInstanceGate
{
    public Authorized: string[] = []
    public constructor(private readonly target: IWriteTargetSource)
    {
    }

    public CreateDefaults(): readonly { field: string; value: string }[]
    {
        return []
    }

    public Authorize(): boolean
    {
        return true
    }

    public async AuthorizeById(_action: PrivilegeAction, concept: string, id: string): Promise<boolean>
    {
        this.Authorized.push(id)
        return (await this.target.Fetch(concept, id)) !== undefined
    }

    public Resolve(concept: string, id: string): Promise<IInstanceView | undefined>
    {
        return this.target.Fetch(concept, id)
    }

    public CanWriteField(): boolean
    {
        return true
    }
}

test('an upsert applies edited fields to the binding without pulling the whole concept', async () =>
{
    const w = Fx.World()
    const target = new KeyedWriteTargetSource(w.plan, w.opener)
    const gate = new KeyedGate(target)
    const res = await Fx.Writer(w, { authorizer: ConnectorHydrateWriter.AllowAll().authorizer, gate }).Apply({ modelId: 'm', operations: [Fx.Op()] })
    assert.deepEqual(res.results, [{ key: 'C1', status: AppWriteStatus.Applied }])
    assert.equal(w.a.Queries.length, 1)
    assert.deepEqual(w.a.Queries[0]!.Where, { All: [{ Field: 'id', Op: 'eq', Value: 'C1' }] })
    assert.equal(w.a.Batches.length, 1)
    assert.deepEqual(w.a.Batches[0]!.Operations[0], { Kind: WriteOperationKind.Upsert, Key: 'C1', Fields: { name: 'New' } })
    assert.deepEqual(w.opener.Opened.filter(n => n === 'b'), [])
    assert.equal(w.b.Queries.length, 0)
})

test('delete-by-key works', async () =>
{
    const w = Fx.World()
    const res = await Fx.Writer(w).Apply({ modelId: 'm', operations: [Fx.Op({ op: ConnectorWriteOp.Delete, fields: undefined })] })
    assert.deepEqual(res.results, [{ key: 'C1', status: AppWriteStatus.Applied }])
    assert.deepEqual(w.a.Batches[0]!.Operations[0], { Kind: WriteOperationKind.Delete, Key: 'C1', Fields: {} })
})

test('an Optimistic binding applies with a matching expectedVersion, conflicts when stale, and fails closed when absent', async () =>
{
    const w = Fx.World(Fx.Binding('Customer', 'a', { Concurrency: WriteConcurrency.Optimistic, VersionField: 'ver' }))
    const res = await Fx.Writer(w).Apply({ modelId: 'm', operations: [
        Fx.Op({ key: 'C1', expectedVersion: 1 }),
        Fx.Op({ key: 'C2', expectedVersion: 99 }),
    ] })
    assert.equal(res.results[0]!.status, AppWriteStatus.Applied)
    assert.equal(res.results[1]!.status, AppWriteStatus.Conflict)
    assert.equal(w.a.Batches[0]!.Operations[0]!.Version, 1)

    const w2 = Fx.World(Fx.Binding('Customer', 'a', { Concurrency: WriteConcurrency.Optimistic, VersionField: 'ver' }))
    const none = await Fx.Writer(w2).Apply({ modelId: 'm', operations: [Fx.Op()] })
    assert.equal(none.results[0]!.status, AppWriteStatus.Conflict)
    assert.equal(w2.a.Batches.length, 0, 'no unversioned optimistic write was sent')
})

test('authorization uses the keyed Fetch (one keyed query), not a whole-concept prefetch', async () =>
{
    const w = Fx.World()
    const gate = new KeyedGate(new KeyedWriteTargetSource(w.plan, w.opener))
    await Fx.Writer(w, { authorizer: ConnectorHydrateWriter.AllowAll().authorizer, gate }).Apply({ modelId: 'm', operations: [Fx.Op({ key: 'C2' })] })
    assert.deepEqual(gate.Authorized, ['C2'])
    assert.equal(w.a.Queries.length, 1)
    assert.deepEqual(w.a.Queries[0]!.Where!.All, [{ Field: 'id', Op: 'eq', Value: 'C2' }])
    assert.equal(w.b.Queries.length, 0)
    assert.equal(w.opener.Opened.includes('b'), false)
})

test('an absent target row is denied and nothing is written', async () =>
{
    const w = Fx.World()
    const gate = new KeyedGate(new KeyedWriteTargetSource(w.plan, w.opener))
    const res = await Fx.Writer(w, { authorizer: ConnectorHydrateWriter.AllowAll().authorizer, gate }).Apply({ modelId: 'm', operations: [Fx.Op({ key: 'nope' })] })
    assert.equal(res.results[0]!.status, AppWriteStatus.Denied)
    assert.equal(w.a.Batches.length, 0)
})

test('failures de-conflate: Error->failed, Conflict->conflict, Unsupported->invalid', async () =>
{
    const expected = new Map<WriteFailureKind, AppWriteStatus>([[WriteFailureKind.Error, AppWriteStatus.Failed], [WriteFailureKind.Conflict, AppWriteStatus.Conflict], [WriteFailureKind.Unsupported, AppWriteStatus.Invalid]])
    for (const [kind, status] of expected)
    {
        const w = Fx.World()
        w.a.Failure = kind
        const res = await Fx.Writer(w).Apply({ modelId: 'm', operations: [Fx.Op()] })
        assert.equal(res.results[0]!.status, status)
    }
})

test('an adapter throw yields failed with no secret in the reason', async () =>
{
    const w = Fx.World()
    w.a.Throw = true
    const res = await Fx.Writer(w).Apply({ modelId: 'm', operations: [Fx.Op()] })
    assert.equal(res.results[0]!.status, AppWriteStatus.Failed)
    assert.equal(JSON.stringify(res).includes('secret'), false)
    assert.equal(JSON.stringify(res).includes('sekret'), false)
})

test('an unknown (concept,connector,source) binding is invalid', async () =>
{
    const w = Fx.World()
    const res = await Fx.Writer(w).Apply({ modelId: 'm', operations: [Fx.Op({ connector: 'zzz' }), Fx.Op({ source: 'Other' }), Fx.Op({ concept: 'Nope' })] })
    assert.deepEqual(res.results.map(r => r.status), [AppWriteStatus.Invalid, AppWriteStatus.Invalid, AppWriteStatus.Invalid])
    assert.equal(w.a.Batches.length, 0)
})

test('a read-only binding is denied', async () =>
{
    const w = Fx.World(Fx.Binding('Customer', 'a', { Writable: false }))
    const res = await Fx.Writer(w).Apply({ modelId: 'm', operations: [Fx.Op()] })
    assert.equal(res.results[0]!.status, AppWriteStatus.Denied)
})

test('an unmapped, id, or version field key is invalid and nothing is sent; a mapped field still applies', async () =>
{
    const binding = Fx.Binding('Customer', 'a', { Concurrency: WriteConcurrency.Optimistic, VersionField: 'ver', FieldMap: { name: 'name', rev: 'ver', ident: 'id' } })
    const w = Fx.World(binding)
    const res = await Fx.Writer(w).Apply({ modelId: 'm', operations: [
        Fx.Op({ key: 'C1', fields: { is_admin: true }, expectedVersion: 1 }),
        Fx.Op({ key: 'C1', fields: { ver: 5 }, expectedVersion: 1 }),
        Fx.Op({ key: 'C1', fields: { rev: 5 }, expectedVersion: 1 }),
        Fx.Op({ key: 'C1', fields: { ident: 'X' }, expectedVersion: 1 }),
        Fx.Op({ key: 'C1', fields: { id: 'X' }, expectedVersion: 1 }),
        Fx.Op({ key: 'C2', fields: { name: 'ok' }, expectedVersion: 1 }),
    ] })
    assert.deepEqual(res.results.map(r => r.status), [AppWriteStatus.Invalid, AppWriteStatus.Invalid, AppWriteStatus.Invalid, AppWriteStatus.Invalid, AppWriteStatus.Invalid, AppWriteStatus.Applied])
    assert.equal(w.a.Batches.length, 1)
    assert.equal(w.a.Batches[0]!.Operations.length, 1)
})

test('optimistic delete: no version is conflict with nothing sent; matching applies; stale conflicts', async () =>
{
    const mk = (): ReturnType<typeof Fx.World> => Fx.World(Fx.Binding('Customer', 'a', { Concurrency: WriteConcurrency.Optimistic, VersionField: 'ver' }))
    const w1 = mk()
    const none = await Fx.Writer(w1).Apply({ modelId: 'm', operations: [Fx.Op({ op: ConnectorWriteOp.Delete, fields: undefined })] })
    assert.equal(none.results[0]!.status, AppWriteStatus.Conflict)
    assert.equal(w1.a.Batches.length, 0)
    const w2 = mk()
    const ok = await Fx.Writer(w2).Apply({ modelId: 'm', operations: [Fx.Op({ op: ConnectorWriteOp.Delete, fields: undefined, expectedVersion: 1 })] })
    assert.equal(ok.results[0]!.status, AppWriteStatus.Applied)
    assert.equal(w2.a.Batches[0]!.Operations[0]!.Version, 1)
    const w3 = mk()
    const stale = await Fx.Writer(w3).Apply({ modelId: 'm', operations: [Fx.Op({ op: ConnectorWriteOp.Delete, fields: undefined, expectedVersion: 9 })] })
    assert.equal(stale.results[0]!.status, AppWriteStatus.Conflict)
})

test('an authorizer deny sends no write', async () =>
{
    const w = Fx.World()
    const deny = { authorizer: { Allows: () => false }, gate: ConnectorHydrateWriter.AllowAll().gate }
    const res = await Fx.Writer(w, deny).Apply({ modelId: 'm', operations: [Fx.Op()] })
    assert.equal(res.results[0]!.status, AppWriteStatus.Denied)
    assert.equal(w.a.Batches.length, 0)
})

test('a CanWriteField deny sends no write', async () =>
{
    const w = Fx.World()
    const gate = new KeyedGate(new KeyedWriteTargetSource(w.plan, w.opener))
    gate.CanWriteField = () => false
    const res = await Fx.Writer(w, { authorizer: ConnectorHydrateWriter.AllowAll().authorizer, gate }).Apply({ modelId: 'm', operations: [Fx.Op()] })
    assert.equal(res.results[0]!.status, AppWriteStatus.Denied)
    assert.equal(w.a.Batches.length, 0)
})

test('a duplicate key in one batch is invalid for the second op', async () =>
{
    const w = Fx.World()
    const res = await Fx.Writer(w).Apply({ modelId: 'm', operations: [Fx.Op(), Fx.Op()] })
    assert.deepEqual(res.results.map(r => r.status), [AppWriteStatus.Applied, AppWriteStatus.Invalid])
})

test('a transactional batch that rolled back reports the unfaulted ops as failed, the faulting op by its kind', async () =>
{
    const w = Fx.World(Fx.Binding('Customer', 'a', { Atomicity: WriteAtomicity.Transactional }))
    w.a.Custom = { Applied: 0, Failures: [{ Key: 'C2', Kind: WriteFailureKind.Error, Reason: 'boom' }] }
    const res = await Fx.Writer(w).Apply({ modelId: 'm', operations: [Fx.Op({ key: 'C1' }), Fx.Op({ key: 'C2' })] })
    assert.deepEqual(res.results.map(r => r.status), [AppWriteStatus.Failed, AppWriteStatus.Failed])
})
