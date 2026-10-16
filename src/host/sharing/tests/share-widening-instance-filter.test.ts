import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ShareWideningInstanceFilter } from '../share-widening-instance-filter.js'
import { ShareGrantIndex } from '../share-grant-index.js'
import { ShareStore } from '../share-store.js'
import { ConceptIdFields } from '../concept-id-fields.js'
import { ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PrivilegeAction, Principal, PrincipalKind } from '@pragmatic-tech-ai/todl-identity'

class FakeSession
{
    public readonly rows = new Map<string, Record<string, unknown>>()
    public async Find(): Promise<readonly Record<string, unknown>[]> { return [...this.rows.values()] }
    public async Upsert(_c: string, _f: string, key: unknown, doc: Record<string, unknown>): Promise<void> { this.rows.set(String(key), doc) }
    public async Delete(): Promise<boolean> { return false }
}

const Order = 'shop.Order'

class WideningFixture
{
    public static readonly DenyAll = { Keep(): boolean { return false } }
    public static readonly KeepAll = { Keep(): boolean { return true } }
    public static readonly IdFields = ConceptIdFields.From({ Model: 'm', Version: '1', Connectors: [], Bindings: [{ Concept: Order, Connector: 'c', Source: 's', IdKey: 'id', FieldMap: {}, Writable: true }] } as never)

    public static View(id: string)
    {
        return { Concept: Order, Field: (n: string) => (n === 'id' ? id : undefined) }
    }
}

test('a Read share makes an otherwise-denied record visible; the wrong record stays denied', async () =>
{
    const store = new ShareStore(new FakeSession() as never)
    await store.Grant({ concept: Order, recordId: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u2' }, rights: [PrivilegeAction.Read] })
    const index = await ShareGrantIndex.For(store, new Principal('u2', 't1', PrincipalKind.User, new Map(), []), { homeBusinessUnit: 'root', teams: [] })
    const filter = new ShareWideningInstanceFilter(WideningFixture.DenyAll, index, WideningFixture.IdFields)
    assert.equal(filter.Keep(WideningFixture.View('o1') as never), true)
    assert.equal(filter.Keep(WideningFixture.View('o2') as never), false)
})

test('when the inner filter keeps the view, the share is not consulted (never narrows)', () =>
{
    const filter = new ShareWideningInstanceFilter(WideningFixture.KeepAll, ShareGrantIndex.Empty(), WideningFixture.IdFields)
    assert.equal(filter.Keep(WideningFixture.View('anything') as never), true)
})
