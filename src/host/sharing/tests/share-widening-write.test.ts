import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ShareWideningWriteInstanceGate } from '../share-widening-write-instance-gate.js'
import { ShareWideningWriteAuthorizer } from '../share-widening-write-authorizer.js'
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
const idFields = ConceptIdFields.From({ Model: 'm', Version: '1', Connectors: [], Bindings: [{ Concept: Order, Connector: 'c', Source: 's', IdKey: 'id', FieldMap: {}, Writable: true }] } as never)
const view = (id: string) => ({ Concept: Order, RecordKey: id, Field: (n: string) => (n === 'id' ? id : undefined) })

class DenyGate
{
    public CreateDefaults(): readonly { field: string; value: string }[] { return [] }
    public Authorize(): boolean { return false }
    public async AuthorizeById(): Promise<boolean> { return false }
    public async Resolve(_c: string, id: string): Promise<unknown> { return view(id) }
    public CanWriteField(): boolean { return true }
}

async function indexWith(right: PrivilegeAction): Promise<ShareGrantIndex>
{
    const store = new ShareStore(new FakeSession() as never)
    await store.Grant({ concept: Order, recordId: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u2' }, rights: [right] })
    return ShareGrantIndex.For(store, new Principal('u2', 't1', PrincipalKind.User, new Map(), []), { homeBusinessUnit: 'root', teams: [] })
}

test('an Update share lets the holder update that one record though the inner gate denies', async () =>
{
    const gate = new ShareWideningWriteInstanceGate(new DenyGate() as never, await indexWith(PrivilegeAction.Update), idFields)
    assert.equal(gate.Authorize(PrivilegeAction.Update, view('o1') as never), true)
    assert.equal(gate.Authorize(PrivilegeAction.Update, view('o2') as never), false)
    assert.equal(await gate.AuthorizeById(PrivilegeAction.Update, Order, 'o1'), true)
    assert.equal(await gate.AuthorizeById(PrivilegeAction.Delete, Order, 'o1'), false)
})

test('coarse authorizer passes a share-only writer for the granted action only', async () =>
{
    const inner = { Allows(): boolean { return false } }
    const auth = new ShareWideningWriteAuthorizer(inner, await indexWith(PrivilegeAction.Update))
    assert.equal(auth.Allows(Order, PrivilegeAction.Update), true)
    assert.equal(auth.Allows(Order, PrivilegeAction.Delete), false)
})
