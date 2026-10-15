import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ShareStore } from '../share-store.js'
import { ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'

class FakeSession
{
    public readonly rows = new Map<string, Record<string, unknown>>()
    public async Find(_collection: string): Promise<readonly Record<string, unknown>[]> { return [...this.rows.values()] }
    public async Upsert(_c: string, _idField: string, key: unknown, doc: Record<string, unknown>): Promise<void> { this.rows.set(String(key), doc) }
    public async Delete(_c: string, _idField: string, key: unknown): Promise<boolean> { return this.rows.delete(String(key)) }
}

test('grant round-trips through list; revoke removes it', async () =>
{
    const session = new FakeSession()
    const store = new ShareStore(session as never)
    await store.Grant({ concept: 'shop.Order', recordId: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u2' }, rights: [PrivilegeAction.Read, PrivilegeAction.Update] })
    const listed = await store.ListForRecord('shop.Order', 'o1')
    assert.equal(listed.length, 1)
    assert.deepEqual(listed[0].rights, ['read', 'update'])
    assert.equal(await store.Revoke('shop.Order', 'o1', ShareSubjectKind.Principal, 'u2'), true)
    assert.equal((await store.ListForRecord('shop.Order', 'o1')).length, 0)
})

test('unknown rights are dropped and a rights-less grant is ignored (fail-closed)', async () =>
{
    const session = new FakeSession()
    const store = new ShareStore(session as never)
    // A row with only an unknown right => dropped on load.
    session.rows.set('k1', { grantKey: 'k1', concept: 'shop.Order', recordId: 'o9', subject: { kind: 'principal', id: 'u2' }, rights: ['bogus'] })
    // A malformed row (no concept) => dropped.
    session.rows.set('k2', { grantKey: 'k2', recordId: 'o9', subject: { kind: 'principal', id: 'u2' }, rights: ['read'] })
    assert.equal((await store.LoadAll()).length, 0)
})

test('a mix of valid and invalid rights keeps only the valid ones', async () =>
{
    const session = new FakeSession()
    const store = new ShareStore(session as never)
    session.rows.set('k1', { grantKey: 'k1', concept: 'shop.Order', recordId: 'o1', subject: { kind: 'team', id: 't1' }, rights: ['read', 'bogus', 'share'] })
    const all = await store.LoadAll()
    assert.deepEqual(all[0].rights, ['read', 'share'])
    assert.equal(all[0].subject.kind, ShareSubjectKind.Team)
})

test('malformed rows are all dropped (fail-closed)', async () =>
{
    const session = new FakeSession()
    const store = new ShareStore(session as never)
    session.rows.set('k1', { grantKey: 'k1', concept: 'shop.Order', recordId: 'o1', subject: { kind: 'robot', id: 'x' }, rights: ['read'] })
    session.rows.set('k2', { grantKey: 'k2', concept: 'shop.Order', recordId: 'o1', subject: { kind: 'principal', id: '' }, rights: ['read'] })
    session.rows.set('k3', { grantKey: 'k3', concept: 'shop.Order', recordId: 'o1', subject: { kind: 'principal', id: 'u2' }, rights: 'read' })
    session.rows.set('k4', { grantKey: 'k4', concept: 'shop.Order', recordId: 'o1', subject: { kind: 'principal', id: 'u2' }, rights: 42 })
    session.rows.set('k5', { grantKey: 'k5', concept: 'shop.Order', subject: { kind: 'principal', id: 'u2' }, rights: ['read'] })
    assert.equal((await store.LoadAll()).length, 0)
})

test('duplicate rights collapse preserving order', async () =>
{
    const session = new FakeSession()
    const store = new ShareStore(session as never)
    session.rows.set('k1', { grantKey: 'k1', concept: 'shop.Order', recordId: 'o1', subject: { kind: 'principal', id: 'u2' }, rights: ['read', 'read', 'update'] })
    const all = await store.LoadAll()
    assert.equal(all.length, 1)
    assert.deepEqual(all[0].rights, ['read', 'update'])
})
