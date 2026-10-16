import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ShareGrantIndex } from '../share-grant-index.js'
import { ShareStore } from '../share-store.js'
import { ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PrivilegeAction, Principal, PrincipalKind } from '@pragmatic-tech-ai/todl-identity'

class FakeSession
{
    public readonly rows = new Map<string, Record<string, unknown>>()
    public async Find(): Promise<readonly Record<string, unknown>[]> { return [...this.rows.values()] }
    public async Upsert(_c: string, _f: string, key: unknown, doc: Record<string, unknown>): Promise<void> { this.rows.set(String(key), doc) }
    public async Delete(_c: string, _f: string, key: unknown): Promise<boolean> { return this.rows.delete(String(key)) }
}

const Order = 'shop.Order'
class Fx
{
    public static Principal(id: string): Principal { return new Principal(id, 't1', PrincipalKind.User, new Map(), []) }
    public static Membership(teams: string[]) { return { homeBusinessUnit: 'root', teams } }
}

test('a principal grant widens that record+action for that principal only', async () =>
{
    const session = new FakeSession()
    const store = new ShareStore(session as never)
    await store.Grant({ concept: Order, recordId: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u2' }, rights: [PrivilegeAction.Read] })
    const forU2 = await ShareGrantIndex.For(store, Fx.Principal('u2'), Fx.Membership([]))
    assert.equal(forU2.AllowsRecord(Order, 'o1', PrivilegeAction.Read), true)
    assert.equal(forU2.AllowsRecord(Order, 'o1', PrivilegeAction.Update), false)
    assert.equal(forU2.AllowsRecord(Order, 'o2', PrivilegeAction.Read), false)
    const forU3 = await ShareGrantIndex.For(store, Fx.Principal('u3'), Fx.Membership([]))
    assert.equal(forU3.AllowsRecord(Order, 'o1', PrivilegeAction.Read), false)
    assert.equal(forU3.IsEmpty(), true)
})

test('a team grant applies to members of that team; HasAnyGrant reflects the concept', async () =>
{
    const session = new FakeSession()
    const store = new ShareStore(session as never)
    await store.Grant({ concept: Order, recordId: 'o1', subject: { kind: ShareSubjectKind.Team, id: 'sales' }, rights: [PrivilegeAction.Update] })
    const member = await ShareGrantIndex.For(store, Fx.Principal('u9'), Fx.Membership(['sales']))
    assert.equal(member.AllowsRecord(Order, 'o1', PrivilegeAction.Update), true)
    assert.equal(member.HasAnyGrant(Order, PrivilegeAction.Update), true)
    assert.equal(member.HasAnyGrant(Order, PrivilegeAction.Delete), false)
    const outsider = await ShareGrantIndex.For(store, Fx.Principal('u9'), Fx.Membership(['ops']))
    assert.equal(outsider.AllowsRecord(Order, 'o1', PrivilegeAction.Update), false)
})

test('AllowsRecord with an absent record id fails closed', async () =>
{
    const idx = ShareGrantIndex.Empty()
    assert.equal(idx.AllowsRecord(Order, undefined, PrivilegeAction.Read), false)
    assert.equal(idx.AllowsRecord(Order, '', PrivilegeAction.Read), false)
})

test('direct and team grants on the same record union', async () =>
{
    const session = new FakeSession()
    const store = new ShareStore(session as never)
    await store.Grant({ concept: Order, recordId: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u5' }, rights: [PrivilegeAction.Read] })
    await store.Grant({ concept: Order, recordId: 'o1', subject: { kind: ShareSubjectKind.Team, id: 'sales' }, rights: [PrivilegeAction.Update] })
    const idx = await ShareGrantIndex.For(store, Fx.Principal('u5'), Fx.Membership(['sales']))
    assert.equal(idx.AllowsRecord(Order, 'o1', PrivilegeAction.Read), true)
    assert.equal(idx.AllowsRecord(Order, 'o1', PrivilegeAction.Update), true)
})
