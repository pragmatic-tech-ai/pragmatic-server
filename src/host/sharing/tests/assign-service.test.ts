import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AssignService } from '../assign-service.js'
import { ShareStore } from '../share-store.js'
import { ShareGrantIndex } from '../share-grant-index.js'
import { ConceptIdFields } from '../concept-id-fields.js'
import { AssignStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PrivilegeAction, Principal, PrincipalKind, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'

class Fx
{
    public static readonly Lead = 'crm.Lead'
    public static readonly Cfg = 'crm.Config'
    public static readonly Task = 'crm.Task'
    public static readonly WriteFailed = 'write failed'

    public static readonly Plan = {
        Model: 'm',
        Version: '1',
        Connectors: [{ Name: 'c' }],
        Bindings: [
            { Concept: Fx.Lead, Connector: 'c', Source: 'leads', IdKey: 'id', FieldMap: {}, Writable: true },
            { Concept: Fx.Cfg, Connector: 'c', Source: 'cfg', IdKey: 'id', FieldMap: {}, Writable: true },
            { Concept: Fx.Task, Connector: 'c', Source: 'tasks', IdKey: 'id', FieldMap: { ownerid: 'id' }, Writable: true }
        ]
    } as never

    public static Config(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: 'root', name: 'Root' }, { id: 'sales', name: 'Sales', parent: 'root' }],
            teams: [{ id: 'teamA', name: 'Team A', owningBusinessUnit: 'sales' }],
            membership: { claimsMapping: [], overrides: [] },
            ownershipRules: [
                { concept: Fx.Lead, owningBusinessUnit: { kind: OwnershipSourceKind.FromField, value: 'owningbu' }, owner: { kind: OwnershipSourceKind.FromField, value: 'ownerid' } },
                { concept: Fx.Cfg, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: 'root' } },
                { concept: Fx.Task, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: 'root' }, owner: { kind: OwnershipSourceKind.FromField, value: 'ownerid' } }
            ]
        } as ISecurityModelConfig
    }
}

class FakeEvaluator
{
    private readonly real = AccessDepthEvaluator.FromConfig(Fx.Config())
    constructor(private readonly assignOk: boolean) {}
    public Allows(_p: unknown, action: PrivilegeAction): boolean { return this.assignOk && action === PrivilegeAction.Assign }
    public AssignWrites(c: string, o: string, t: boolean, b: string | undefined) { return this.real.AssignWrites(c, o, t, b) }
}

class FakeTarget
{
    constructor(private readonly concept: string | undefined) {}
    public async Fetch(_concept: string, id: string): Promise<unknown>
    {
        return this.concept === undefined ? undefined : { Concept: this.concept, Field: (n: string) => (n === 'id' ? id : undefined) }
    }
}

class FakeAdapter
{
    public readonly batches: any[] = []
    constructor(private readonly conflicts: { Key: string; Reason: string }[], private readonly fails: boolean = false) {}
    public async Apply(batch: unknown): Promise<unknown> { if (this.fails) { throw new Error('boom') } this.batches.push(batch); return { Applied: 1, Conflicts: this.conflicts } }
}

class FakeCatalog
{
    constructor(private readonly adapter: FakeAdapter) {}
    public async Open(): Promise<FakeAdapter> { return this.adapter }
}

class FakeSession
{
    public readonly rows = new Map<string, Record<string, unknown>>()
    public async Find(): Promise<readonly Record<string, unknown>[]> { return [...this.rows.values()] }
    public async Upsert(_c: string, _f: string, key: unknown, doc: Record<string, unknown>): Promise<void> { this.rows.set(String(key), doc) }
    public async Delete(_c: string, _f: string, key: unknown): Promise<boolean> { return this.rows.delete(String(key)) }
}

class Factory
{
    public static Principal(): Principal { return new Principal('u1', 't1', PrincipalKind.User, new Map(), []) }

    public static Build(opts: { assignOk: boolean; concept?: string; visible?: boolean; index?: ShareGrantIndex; conflicts?: { Key: string; Reason: string }[]; fail?: boolean }): { svc: AssignService; adapter: FakeAdapter }
    {
        const adapter = new FakeAdapter(opts.conflicts ?? [], opts.fail === true)
        const concept = opts.visible === false ? undefined : (opts.concept ?? Fx.Lead)
        const svc = new AssignService(new FakeEvaluator(opts.assignOk) as never, opts.index ?? ShareGrantIndex.Empty(), Factory.Principal(), new FakeTarget(concept) as never, ConceptIdFields.From(Fx.Plan), Fx.Plan, new FakeCatalog(adapter) as never, {} as never)
        return { svc, adapter }
    }
}

test('role-authorized assign applies ownership writes', async () =>
{
    const { svc, adapter } = Factory.Build({ assignOk: true })
    const result = await svc.Assign({ concept: Fx.Lead, id: 'r1', owner: { kind: ShareSubjectKind.Principal, id: 'u9' }, owningBu: 'sales' })
    assert.equal(result.status, AssignStatus.Applied)
    assert.equal(adapter.batches.length, 1)
    const op = adapter.batches[0].Operations[0]
    assert.equal(op.Key, 'r1')
    assert.deepEqual(op.Fields, { ownerid: 'u9', owningbu: 'sales' })
})

test('actor lacking the Assign right is denied and nothing is written', async () =>
{
    const { svc, adapter } = Factory.Build({ assignOk: false })
    const result = await svc.Assign({ concept: Fx.Lead, id: 'r1', owner: { kind: ShareSubjectKind.Principal, id: 'u9' }, owningBu: 'sales' })
    assert.equal(result.status, AssignStatus.Denied)
    assert.equal(adapter.batches.length, 0)
})

test('unreachable unshared record is not found', async () =>
{
    const { svc, adapter } = Factory.Build({ assignOk: true, visible: false })
    const result = await svc.Assign({ concept: Fx.Lead, id: 'r1', owner: { kind: ShareSubjectKind.Principal, id: 'u9' }, owningBu: 'sales' })
    assert.equal(result.status, AssignStatus.NotFound)
    assert.equal(adapter.batches.length, 0)
})

test('assign share authorizes an unreadable record by id', async () =>
{
    const store = new ShareStore(new FakeSession() as never)
    await store.Grant({ concept: Fx.Lead, recordId: 'r1', subject: { kind: ShareSubjectKind.Principal, id: 'u1' }, rights: [PrivilegeAction.Assign] })
    const index = await ShareGrantIndex.For(store, Factory.Principal(), { homeBusinessUnit: 'root', teams: [] })
    const { svc, adapter } = Factory.Build({ assignOk: false, visible: false, index })
    const result = await svc.Assign({ concept: Fx.Lead, id: 'r1', owner: { kind: ShareSubjectKind.Principal, id: 'u9' }, owningBu: 'sales' })
    assert.equal(result.status, AssignStatus.Applied)
    assert.equal(adapter.batches.length, 1)
})

test('non-assignable concept is unsupported', async () =>
{
    const { svc, adapter } = Factory.Build({ assignOk: true, concept: Fx.Cfg })
    const result = await svc.Assign({ concept: Fx.Cfg, id: 'r1', owner: { kind: ShareSubjectKind.Principal, id: 'u9' } })
    assert.equal(result.status, AssignStatus.Unsupported)
    assert.equal(adapter.batches.length, 0)
})

test('principal owner without owningBu is invalid', async () =>
{
    const { svc, adapter } = Factory.Build({ assignOk: true })
    const result = await svc.Assign({ concept: Fx.Lead, id: 'r1', owner: { kind: ShareSubjectKind.Principal, id: 'u9' } })
    assert.equal(result.status, AssignStatus.Invalid)
    assert.equal(adapter.batches.length, 0)
})

test('unknown business unit or team is invalid', async () =>
{
    const { svc, adapter } = Factory.Build({ assignOk: true })
    assert.equal((await svc.Assign({ concept: Fx.Lead, id: 'r1', owner: { kind: ShareSubjectKind.Principal, id: 'u9' }, owningBu: 'nope' })).status, AssignStatus.Invalid)
    assert.equal((await svc.Assign({ concept: Fx.Lead, id: 'r1', owner: { kind: ShareSubjectKind.Team, id: 'ghost' } })).status, AssignStatus.Invalid)
    assert.equal(adapter.batches.length, 0)
})

test('a team owner derives its owning BU and applies', async () =>
{
    const { svc, adapter } = Factory.Build({ assignOk: true })
    const result = await svc.Assign({ concept: Fx.Lead, id: 'r1', owner: { kind: ShareSubjectKind.Team, id: 'teamA' } })
    assert.equal(result.status, AssignStatus.Applied)
    assert.deepEqual(adapter.batches[0].Operations[0].Fields, { ownerid: 'teamA', owningbu: 'sales' })
})

test('an Update-only share does not authorize assign', async () =>
{
    const store = new ShareStore(new FakeSession() as never)
    await store.Grant({ concept: Fx.Lead, recordId: 'r1', subject: { kind: ShareSubjectKind.Principal, id: 'u1' }, rights: [PrivilegeAction.Update] })
    const index = await ShareGrantIndex.For(store, Factory.Principal(), { homeBusinessUnit: 'root', teams: [] })
    const { svc, adapter } = Factory.Build({ assignOk: false, index })
    const result = await svc.Assign({ concept: Fx.Lead, id: 'r1', owner: { kind: ShareSubjectKind.Principal, id: 'u9' }, owningBu: 'sales' })
    assert.equal(result.status, AssignStatus.Denied)
    assert.equal(adapter.batches.length, 0)
})

test('ownership writes that all map to the id key are invalid, not applied', async () =>
{
    const { svc, adapter } = Factory.Build({ assignOk: true, concept: Fx.Task })
    const result = await svc.Assign({ concept: Fx.Task, id: 'r1', owner: { kind: ShareSubjectKind.Principal, id: 'u9' } })
    assert.equal(result.status, AssignStatus.Invalid)
    assert.equal(adapter.batches.length, 0)
})

test('an adapter fault is denied with a write-failed reason, not a conflict', async () =>
{
    const { svc } = Factory.Build({ assignOk: true, fail: true })
    const result = await svc.Assign({ concept: Fx.Lead, id: 'r1', owner: { kind: ShareSubjectKind.Principal, id: 'u9' }, owningBu: 'sales' })
    assert.equal(result.status, AssignStatus.Denied)
    assert.equal(result.reason, Fx.WriteFailed)
})

test('a write conflict denies the assign', async () =>
{
    const { svc } = Factory.Build({ assignOk: true, conflicts: [{ Key: 'r1', Reason: 'etag' }] })
    const result = await svc.Assign({ concept: Fx.Lead, id: 'r1', owner: { kind: ShareSubjectKind.Principal, id: 'u9' }, owningBu: 'sales' })
    assert.equal(result.status, AssignStatus.Denied)
})
