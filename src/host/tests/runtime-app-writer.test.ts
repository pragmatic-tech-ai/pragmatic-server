import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cardinality, WriteOperationKind, DataSourceKind } from '@pragmatic-tech-ai/todl'
import type { ModelConnectorPlan, WriteBatch, WriteResult } from '@pragmatic-tech-ai/todl'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import { AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppWriteOpDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { RuntimeAppWriter } from '../runtime-app-writer.js'
import { RuntimeWritePayloadValidator } from '../runtime-write-payload-validator.js'
import type { IWriteAuthorizer } from '../cypher/read-filter-source.js'

// ---- fakes ----
class FakeAdapter
{
    public batches: WriteBatch[] = []
    constructor(private readonly conflictKeys: Set<string> = new Set(), private readonly throwOnApply = false) {}
    public async Query(): Promise<readonly never[]> { return [] }
    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        if (this.throwOnApply)
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
    public static Type(fields: { name: string; type: string; card: Cardinality }[]): unknown
    {
        const prim = (n: string) => ({ name: n, baseType: undefined, getField: () => undefined, getFields: () => [], getRelationships: () => [] })
        const fs = fields.map(f => ({ name: f.name, cardinality: f.card, fieldType: prim(f.type) }))
        return { name: 'shop.Order', baseType: undefined, getField: (n: string) => fs.find(x => x.name === n), getFields: () => fs, getRelationships: () => [] }
    }

    public static Graph(t: unknown): unknown
    {
        return { Type: () => t }
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
        return new RuntimeAppWriter(p, Fx.Graph(t) as never, new FakeCatalog(adapter) as never, {} as never, auth, new RuntimeWritePayloadValidator())
    }
}

// ---- tests ---- (call sites below use Fx.Plan / Fx.Writer; `plan(` → `Fx.Plan(`, `writer(` → `Fx.Writer(`)
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
    const w = new RuntimeAppWriter(p, { Type: () => undefined } as never, new FakeCatalog(adapter) as never, {} as never, new AllowAll(), new RuntimeWritePayloadValidator())
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
