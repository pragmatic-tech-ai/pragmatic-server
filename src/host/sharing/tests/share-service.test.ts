import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ShareService } from '../share-service.js'
import { ShareStore } from '../share-store.js'
import { ShareGrantIndex } from '../share-grant-index.js'
import { ConceptIdFields } from '../concept-id-fields.js'
import { ShareStatus, ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PrivilegeAction, Principal, PrincipalKind } from '@pragmatic-tech-ai/todl-identity'

const Order = 'shop.Order'
const idFields = ConceptIdFields.From({ Model: 'm', Version: '1', Connectors: [], Bindings: [{ Concept: Order, Connector: 'c', Source: 's', IdKey: 'id', FieldMap: {}, Writable: true }] } as never)

class FakeSession
{
    public readonly rows = new Map<string, Record<string, unknown>>()
    public async Find(): Promise<readonly Record<string, unknown>[]> { return [...this.rows.values()] }
    public async Upsert(_c: string, _f: string, key: unknown, doc: Record<string, unknown>): Promise<void> { this.rows.set(String(key), doc) }
    public async Delete(_c: string, _f: string, key: unknown): Promise<boolean> { return this.rows.delete(String(key)) }
}

class FakeTarget
{
    constructor(private readonly known: ReadonlySet<string>) {}
    public async Fetch(_concept: string, id: string): Promise<unknown>
    {
        return this.known.has(id) ? { Concept: Order, Field: (n: string) => (n === 'id' ? id : undefined) } : undefined
    }
}

class FakeEvaluator
{
    constructor(private readonly shareOk: boolean, private readonly teams: ReadonlySet<string>) {}
    public Allows(_p: unknown, action: PrivilegeAction): boolean { return this.shareOk && action === PrivilegeAction.Share }
    public IsKnownTeam(id: string): boolean { return this.teams.has(id) }
}

class ServiceFactory
{
    public static Build(opts: { shareOk: boolean; known?: string[]; teams?: string[] }): { svc: ShareService; store: ShareStore }
    {
        const store = new ShareStore(new FakeSession() as never)
        const svc = new ShareService(store, ShareGrantIndex.Empty(), new FakeEvaluator(opts.shareOk, new Set(opts.teams ?? [])) as never, new Principal('u1', 't1', PrincipalKind.User, new Map(), []), new FakeTarget(new Set(opts.known ?? ['o1'])) as never, idFields)
        return { svc, store }
    }
}

test('an actor with Share right shares a visible record', async () =>
{
    const { svc, store } = ServiceFactory.Build({ shareOk: true })
    const out = await svc.Share({ concept: Order, id: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u2' }, rights: [PrivilegeAction.Read] })
    assert.equal(out.status, ShareStatus.Applied)
    assert.equal((await store.ListForRecord(Order, 'o1')).length, 1)
})

test('sharing a record the actor cannot Share is Denied', async () =>
{
    const { svc } = ServiceFactory.Build({ shareOk: false })
    const out = await svc.Share({ concept: Order, id: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u2' }, rights: [PrivilegeAction.Read] })
    assert.equal(out.status, ShareStatus.Denied)
})

test('sharing a non-visible record is NotFound', async () =>
{
    const { svc } = ServiceFactory.Build({ shareOk: true, known: [] })
    const out = await svc.Share({ concept: Order, id: 'ghost', subject: { kind: ShareSubjectKind.Principal, id: 'u2' }, rights: [PrivilegeAction.Read] })
    assert.equal(out.status, ShareStatus.NotFound)
})

test('an empty/invalid rights list is Invalid; an unknown team is Invalid', async () =>
{
    const { svc } = ServiceFactory.Build({ shareOk: true, teams: ['sales'] })
    assert.equal((await svc.Share({ concept: Order, id: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u2' }, rights: ['bogus'] })).status, ShareStatus.Invalid)
    assert.equal((await svc.Share({ concept: Order, id: 'o1', subject: { kind: ShareSubjectKind.Team, id: 'ghost' }, rights: [PrivilegeAction.Read] })).status, ShareStatus.Invalid)
    assert.equal((await svc.Share({ concept: Order, id: 'o1', subject: { kind: ShareSubjectKind.Team, id: 'sales' }, rights: [PrivilegeAction.Read] })).status, ShareStatus.Applied)
})

test('unshare removes the grant; unshare of a missing grant is NotFound', async () =>
{
    const { svc } = ServiceFactory.Build({ shareOk: true })
    await svc.Share({ concept: Order, id: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u2' }, rights: [PrivilegeAction.Read] })
    assert.equal((await svc.Unshare({ concept: Order, id: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u2' } })).status, ShareStatus.Applied)
    assert.equal((await svc.Unshare({ concept: Order, id: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u2' } })).status, ShareStatus.NotFound)
})

test('cascade: a principal holding a Share grant (via the index) can re-share', async () =>
{
    const store = new ShareStore(new FakeSession() as never)
    await store.Grant({ concept: Order, recordId: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u1' }, rights: [PrivilegeAction.Share] })
    const index = await ShareGrantIndex.For(store, new Principal('u1', 't1', PrincipalKind.User, new Map(), []), { homeBusinessUnit: 'root', teams: [] })
    const svc = new ShareService(store, index, new FakeEvaluator(false, new Set()) as never, new Principal('u1', 't1', PrincipalKind.User, new Map(), []), new FakeTarget(new Set(['o1'])) as never, idFields)
    const out = await svc.Share({ concept: Order, id: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u3' }, rights: [PrivilegeAction.Read] })
    assert.equal(out.status, ShareStatus.Applied)
})
