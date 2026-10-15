import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cardinality, WriteOperationKind, DataSourceKind } from '@pragmatic-tech-ai/todl'
import type { ModelConnectorPlan, WriteBatch, WriteResult, IInstanceView } from '@pragmatic-tech-ai/todl'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import { AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppWriteOpDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { RuntimeAppWriter } from '../runtime-app-writer.js'
import { RuntimeWritePayloadValidator } from '../runtime-write-payload-validator.js'
import type { IWriteAuthorizer } from '../cypher/read-filter-source.js'
import { AllowAllWriteInstanceGate } from '../cypher/write-instance-gate.js'
import type { IWriteInstanceGate } from '../cypher/write-instance-gate.js'

// ---- fakes ----
class FakeAdapter
{
    public batches: WriteBatch[] = []
    constructor(private readonly conflictKeys: Set<string> = new Set(), private readonly throwOnApply = false, private readonly throwOnSource = '') {}
    public async Query(): Promise<readonly never[]> { return [] }
    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        if (this.throwOnApply || batch.Source === this.throwOnSource)
        {
            throw new Error('adapter exploded')
        }
        this.batches.push(batch)
        const conflicts = batch.Operations.filter(o => this.conflictKeys.has(String(o.Key))).map(o => ({ Key: o.Key, Reason: 'version' }))
        return { Applied: batch.Operations.length - conflicts.length, Conflicts: conflicts }
    }
    public async Dispose(): Promise<void> {}
}

class FakeCatalog
{
    constructor(private readonly adapter: FakeAdapter) {}
    public async Open(): Promise<FakeAdapter> { return this.adapter }
}

class AllowAll implements IWriteAuthorizer
{
    public Allows(): boolean { return true }
}

class DenyDelete implements IWriteAuthorizer
{
    public Allows(_concept: string, action: PrivilegeAction): boolean { return action !== PrivilegeAction.Delete }
}

class Fx
{
    public static readonly WriteFailed = 'write failed'

    public static Type(fields: { name: string; type: string; card: Cardinality }[]): unknown
    {
        const prim = (n: string) => ({ name: n, baseType: undefined, getField: () => undefined, getFields: () => [], getRelationships: () => [] })
        const fs = fields.map(f => ({ name: f.name, cardinality: f.card, fieldType: prim(f.type) }))
        return { name: 'shop.Order', baseType: undefined, getField: (n: string) => fs.find(x => x.name === n), getFields: () => fs, getRelationships: () => [] }
    }

    public static Graph(t: unknown): unknown
    {
        return { Type: (name: string) => (name === 'shop.Order' || name === 'shop.Gadget' ? t : undefined) }
    }

    public static TwoPlan(): ModelConnectorPlan
    {
        return {
            Model: 'shop', Version: '1',
            Connectors: [{ Name: 'c', Kind: DataSourceKind.Builtin, Config: {} }],
            Bindings: [
                { Concept: 'shop.Order', Connector: 'c', Source: 'orders', IdKey: 'id', FieldMap: {}, Writable: true },
                { Concept: 'shop.Gadget', Connector: 'c', Source: 'gadgets', IdKey: 'id', FieldMap: {}, Writable: true },
            ],
        } as ModelConnectorPlan
    }

    public static MappedPlan(): ModelConnectorPlan
    {
        return {
            Model: 'shop', Version: '1',
            Connectors: [{ Name: 'c', Kind: DataSourceKind.Builtin, Config: {} }],
            Bindings: [{ Concept: 'shop.Order', Connector: 'c', Source: 'orders', IdKey: 'oid', FieldMap: { label: 'lbl', ident: 'oid' }, Writable: true }],
        } as ModelConnectorPlan
    }

    public static MappedWriter(adapter: FakeAdapter): RuntimeAppWriter
    {
        const t = Fx.Type([
            { name: 'label', type: 'string', card: Cardinality.Optional },
            { name: 'ident', type: 'string', card: Cardinality.Optional },
        ])
        return new RuntimeAppWriter(Fx.MappedPlan(), Fx.Graph(t) as never, new FakeCatalog(adapter) as never, {} as never, new AllowAll(), new RuntimeWritePayloadValidator(), AllowAllWriteInstanceGate.Instance)
    }

    public static Plan(writable: boolean, kind: DataSourceKind): ModelConnectorPlan
    {
        return {
            Model: 'shop', Version: '1',
            Connectors: [{ Name: 'c', Kind: kind, Config: {} }],
            Bindings: [{ Concept: 'shop.Order', Connector: 'c', Source: 'orders', IdKey: 'id', FieldMap: {}, Writable: writable }],
        } as ModelConnectorPlan
    }

    public static Writer(p: ModelConnectorPlan, adapter: FakeAdapter, auth: IWriteAuthorizer): RuntimeAppWriter
    {
        const t = Fx.Type([{ name: 'title', type: 'string', card: Cardinality.One }])
        return new RuntimeAppWriter(p, Fx.Graph(t) as never, new FakeCatalog(adapter) as never, {} as never, auth, new RuntimeWritePayloadValidator(), AllowAllWriteInstanceGate.Instance)
    }
}

// ---- tests ----
test('create on built-in mints a server id and applies', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.Writer(Fx.Plan(true, DataSourceKind.Builtin), adapter, new AllowAll())
    const ops: AppWriteOpDto[] = [{ op: AppWriteOpKind.Create, concept: 'shop.Order', fields: { title: 'Widget' } }]
    const out = await w.Apply(ops)
    assert.equal(out.results[0].status, AppWriteStatus.Applied)
    assert.ok(out.results[0].id && out.results[0].id.length > 0)
    assert.equal(adapter.batches[0].Operations[0].Kind, WriteOperationKind.Upsert)
    assert.equal(adapter.batches[0].Operations[0].Fields.title, 'Widget')
})

test('create on external without id is Invalid', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.Writer(Fx.Plan(true, DataSourceKind.Sql), adapter, new AllowAll())
    const out = await w.Apply([{ op: AppWriteOpKind.Create, concept: 'shop.Order', fields: { title: 'x' } }])
    assert.equal(out.results[0].status, AppWriteStatus.Invalid)
})

test('delete without id is Invalid', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.Writer(Fx.Plan(true, DataSourceKind.Builtin), adapter, new AllowAll())
    const out = await w.Apply([{ op: AppWriteOpKind.Delete, concept: 'shop.Order' }])
    assert.equal(out.results[0].status, AppWriteStatus.Invalid)
})

test('read-only binding denies writes', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.Writer(Fx.Plan(false, DataSourceKind.Sql), adapter, new AllowAll())
    const out = await w.Apply([{ op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o1', fields: { title: 'x' } }])
    assert.equal(out.results[0].status, AppWriteStatus.Denied)
})

test('privilege denial per action', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.Writer(Fx.Plan(true, DataSourceKind.Builtin), adapter, new DenyDelete())
    const out = await w.Apply([
        { op: AppWriteOpKind.Create, concept: 'shop.Order', fields: { title: 'x' } },
        { op: AppWriteOpKind.Delete, concept: 'shop.Order', id: 'o1' },
    ])
    assert.equal(out.results[0].status, AppWriteStatus.Applied)
    assert.equal(out.results[1].status, AppWriteStatus.Denied)
})

test('unknown concept is Invalid', async () =>
{
    const adapter = new FakeAdapter()
    const p = Fx.Plan(true, DataSourceKind.Builtin)
    const w = new RuntimeAppWriter(p, { Type: () => undefined } as never, new FakeCatalog(adapter) as never, {} as never, new AllowAll(), new RuntimeWritePayloadValidator(), AllowAllWriteInstanceGate.Instance)
    const out = await w.Apply([{ op: AppWriteOpKind.Create, concept: 'shop.Ghost', id: 'g1', fields: {} }])
    assert.equal(out.results[0].status, AppWriteStatus.Invalid)
})

test('batch partial success keeps input order', async () =>
{
    const adapter = new FakeAdapter(new Set(['o2']))
    const w = Fx.Writer(Fx.Plan(true, DataSourceKind.Builtin), adapter, new AllowAll())
    const out = await w.Apply([
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o1', fields: { title: 'a' } },
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o2', fields: { title: 'b' } },
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o3', fields: { title: 'c' } },
    ])
    assert.equal(out.results[0].status, AppWriteStatus.Applied)
    assert.equal(out.results[1].status, AppWriteStatus.Conflict)
    assert.equal(out.results[2].status, AppWriteStatus.Applied)
})

test('adapter exception maps the group to Conflict and still returns', async () =>
{
    const adapter = new FakeAdapter(new Set(), true)
    const w = Fx.Writer(Fx.Plan(true, DataSourceKind.Builtin), adapter, new AllowAll())
    const out = await w.Apply([{ op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o1', fields: { title: 'a' } }])
    assert.equal(out.results[0].status, AppWriteStatus.Conflict)
    assert.ok(out.results[0].reason)
})

test('interleaved ops across two bindings land in input order', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.Writer(Fx.TwoPlan(), adapter, new AllowAll())
    const out = await w.Apply([
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o1', fields: { title: 'a' } },
        { op: AppWriteOpKind.Update, concept: 'shop.Gadget', id: 'g1', fields: { title: 'b' } },
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o2', fields: { title: 'c' } },
    ])
    assert.deepEqual(out.results.map(r => r.status), [AppWriteStatus.Applied, AppWriteStatus.Applied, AppWriteStatus.Applied])
    assert.deepEqual(out.results.map(r => r.id), ['o1', 'g1', 'o2'])
})

test('invalid op between valid ops keeps order', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.Writer(Fx.TwoPlan(), adapter, new AllowAll())
    const out = await w.Apply([
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o1', fields: { title: 'a' } },
        { op: AppWriteOpKind.Update, concept: 'shop.Ghost', id: 'x', fields: {} },
        { op: AppWriteOpKind.Update, concept: 'shop.Gadget', id: 'g1', fields: { title: 'b' } },
    ])
    assert.deepEqual(out.results.map(r => r.status), [AppWriteStatus.Applied, AppWriteStatus.Invalid, AppWriteStatus.Applied])
})

test('adapter throw in one binding leaves the other group applied', async () =>
{
    const adapter = new FakeAdapter(new Set(), false, 'gadgets')
    const w = Fx.Writer(Fx.TwoPlan(), adapter, new AllowAll())
    const out = await w.Apply([
        { op: AppWriteOpKind.Update, concept: 'shop.Gadget', id: 'g1', fields: { title: 'b' } },
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o1', fields: { title: 'a' } },
        { op: AppWriteOpKind.Update, concept: 'shop.Gadget', id: 'g2', fields: { title: 'c' } },
    ])
    assert.deepEqual(out.results.map(r => r.status), [AppWriteStatus.Conflict, AppWriteStatus.Applied, AppWriteStatus.Conflict])
    assert.equal(out.results[0].reason, Fx.WriteFailed)
    assert.equal(out.results[2].reason, Fx.WriteFailed)
    assert.equal(out.results[1].reason, undefined)
})

test('same key twice in one group makes the duplicate Invalid', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.Writer(Fx.Plan(true, DataSourceKind.Builtin), adapter, new AllowAll())
    const out = await w.Apply([
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o1', fields: { title: 'a' } },
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o1', fields: { title: 'b' } },
    ])
    assert.equal(out.results[0].status, AppWriteStatus.Applied)
    assert.equal(out.results[1].status, AppWriteStatus.Invalid)
    assert.equal(adapter.batches[0].Operations.length, 1)
})

class ThrowOnDelete implements IWriteAuthorizer
{
    public Allows(_concept: string, action: PrivilegeAction): boolean
    {
        if (action === PrivilegeAction.Delete)
        {
            throw new Error('policy boom')
        }
        return true
    }
}

class DenyAll implements IWriteAuthorizer
{
    public Allows(): boolean { return false }
}

test('authorizer throw is contained to its op', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.Writer(Fx.Plan(true, DataSourceKind.Builtin), adapter, new ThrowOnDelete())
    const out = await w.Apply([
        { op: AppWriteOpKind.Delete, concept: 'shop.Order', id: 'o1' },
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o2', fields: { title: 'a' } },
    ])
    assert.equal(out.results[0].status, AppWriteStatus.Invalid)
    assert.equal(out.results[0].reason, Fx.WriteFailed)
    assert.equal(out.results[1].status, AppWriteStatus.Applied)
})

test('update without id and unknown op kind are Invalid with distinct reasons', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.Writer(Fx.Plan(true, DataSourceKind.Builtin), adapter, new AllowAll())
    const out = await w.Apply([
        { op: AppWriteOpKind.Update, concept: 'shop.Order', fields: { title: 'a' } },
        { op: 'bogus' as AppWriteOpKind, concept: 'shop.Order', id: 'o1' },
    ])
    assert.equal(out.results[0].status, AppWriteStatus.Invalid)
    assert.equal(out.results[1].status, AppWriteStatus.Invalid)
    assert.notEqual(out.results[0].reason, out.results[1].reason)
    assert.equal(adapter.batches.length, 0)
})

test('fully rejected batch never reaches the adapter', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.Writer(Fx.Plan(true, DataSourceKind.Builtin), adapter, new DenyAll())
    const out = await w.Apply([
        { op: AppWriteOpKind.Create, concept: 'shop.Order', fields: { title: 'x' } },
        { op: AppWriteOpKind.Delete, concept: 'shop.Order', id: 'o1' },
    ])
    assert.deepEqual(out.results.map(r => r.status), [AppWriteStatus.Denied, AppWriteStatus.Denied])
    assert.equal(adapter.batches.length, 0)
})

test('create maps member names to external names and drops the id field', async () =>
{
    const adapter = new FakeAdapter()
    const w = Fx.MappedWriter(adapter)
    const out = await w.Apply([{ op: AppWriteOpKind.Create, concept: 'shop.Order', fields: { label: 'L', ident: 'zzz' } }])
    assert.equal(out.results[0].status, AppWriteStatus.Applied)
    assert.deepEqual(adapter.batches[0].Operations[0].Fields, { lbl: 'L' })
})

class FakeGate implements IWriteInstanceGate
{
    public authorizeByIdCalls = 0
    public authorizeCalls = 0
    constructor(
        private readonly defaults: readonly { field: string; value: string }[] = [],
        private readonly byId: (id: string) => boolean = () => true,
        private readonly byView: (view: IInstanceView) => boolean = () => true) {}
    public CreateDefaults(): readonly { field: string; value: string }[] { return this.defaults }
    public Authorize(_action: PrivilegeAction, view: IInstanceView): boolean { this.authorizeCalls++; return this.byView(view) }
    public async AuthorizeById(_action: PrivilegeAction, _concept: string, id: string): Promise<boolean> { this.authorizeByIdCalls++; return this.byId(id) }
}

class GateFx
{
    public static OwnedType(): unknown
    {
        return Fx.Type([
            { name: 'title', type: 'string', card: Cardinality.One },
            { name: 'owner', type: 'string', card: Cardinality.Optional },
            { name: 'owningBu', type: 'string', card: Cardinality.Optional },
        ])
    }

    public static Writer(adapter: FakeAdapter, gate: IWriteInstanceGate): RuntimeAppWriter
    {
        return new RuntimeAppWriter(Fx.Plan(true, DataSourceKind.Builtin), Fx.Graph(GateFx.OwnedType()) as never, new FakeCatalog(adapter) as never, {} as never, new AllowAll(), new RuntimeWritePayloadValidator(), gate)
    }
}

test('per-instance gate denies an out-of-scope update (write depth narrower than read)', async () =>
{
    const adapter = new FakeAdapter()
    const gate = new FakeGate([], id => id === 'o1')
    const w = GateFx.Writer(adapter, gate)
    const out = await w.Apply([
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o1', fields: { title: 'a' } },
        { op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o2', fields: { title: 'b' } },
    ])
    assert.equal(out.results[0].status, AppWriteStatus.Applied)
    assert.equal(out.results[1].status, AppWriteStatus.Denied)
    assert.equal(out.results[1].reason, 'not authorized for this record')
    assert.equal(adapter.batches[0].Operations.length, 1)
})

test('per-instance gate denies a delete of a non-fetchable row', async () =>
{
    const adapter = new FakeAdapter()
    const w = GateFx.Writer(adapter, new FakeGate([], () => false))
    const out = await w.Apply([{ op: AppWriteOpKind.Delete, concept: 'shop.Order', id: 'gone' }])
    assert.equal(out.results[0].status, AppWriteStatus.Denied)
    assert.equal(out.results[0].reason, 'not authorized for this record')
    assert.equal(adapter.batches.length, 0)
})

test('create stamps omitted owner/BU defaults into the persisted fields', async () =>
{
    const adapter = new FakeAdapter()
    const gate = new FakeGate([{ field: 'owner', value: 'u1' }, { field: 'owningBu', value: 'sales' }], () => true, v => v.Field('owningBu') === 'sales')
    const w = GateFx.Writer(adapter, gate)
    const out = await w.Apply([{ op: AppWriteOpKind.Create, concept: 'shop.Order', fields: { title: 'x' } }])
    assert.equal(out.results[0].status, AppWriteStatus.Applied)
    assert.equal(adapter.batches[0].Operations[0].Fields.owner, 'u1')
    assert.equal(adapter.batches[0].Operations[0].Fields.owningBu, 'sales')
})

test('create with an explicit out-of-scope owner is denied and does not overwrite it', async () =>
{
    const adapter = new FakeAdapter()
    const gate = new FakeGate([{ field: 'owningBu', value: 'sales' }], () => true, v => v.Field('owningBu') === 'sales')
    const w = GateFx.Writer(adapter, gate)
    const out = await w.Apply([{ op: AppWriteOpKind.Create, concept: 'shop.Order', fields: { title: 'x', owningBu: 'root' } }])
    assert.equal(out.results[0].status, AppWriteStatus.Denied)
    assert.equal(adapter.batches.length, 0)
})

test('coarse per-concept deny short-circuits before the per-instance gate', async () =>
{
    const adapter = new FakeAdapter()
    const gate = new FakeGate()
    const w = new RuntimeAppWriter(Fx.Plan(true, DataSourceKind.Builtin), Fx.Graph(GateFx.OwnedType()) as never, new FakeCatalog(adapter) as never, {} as never, new DenyAll(), new RuntimeWritePayloadValidator(), gate)
    const out = await w.Apply([{ op: AppWriteOpKind.Update, concept: 'shop.Order', id: 'o1', fields: { title: 'a' } }])
    assert.equal(out.results[0].status, AppWriteStatus.Denied)
    assert.equal(gate.authorizeByIdCalls, 0)
    assert.equal(gate.authorizeCalls, 0)
})

test('update without id is Invalid before any gate fetch', async () =>
{
    const adapter = new FakeAdapter()
    const gate = new FakeGate()
    const w = GateFx.Writer(adapter, gate)
    const out = await w.Apply([{ op: AppWriteOpKind.Update, concept: 'shop.Order', fields: { title: 'a' } }])
    assert.equal(out.results[0].status, AppWriteStatus.Invalid)
    assert.equal(gate.authorizeByIdCalls, 0)
})

test('create on a concept with no ownership rule stamps nothing and is authorized on the raw payload', async () =>
{
    const adapter = new FakeAdapter()
    const gate = new FakeGate([], () => true, v => v.Field('owningBu') === undefined)
    const w = GateFx.Writer(adapter, gate)
    const out = await w.Apply([{ op: AppWriteOpKind.Create, concept: 'shop.Order', fields: { title: 'x' } }])
    assert.equal(out.results[0].status, AppWriteStatus.Applied)
    assert.equal(adapter.batches[0].Operations[0].Fields.owningBu, undefined)
})
