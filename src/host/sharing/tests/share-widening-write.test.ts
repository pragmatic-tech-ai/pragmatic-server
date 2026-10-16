import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ShareWideningWriteInstanceGate } from '../share-widening-write-instance-gate.js'
import { ShareWideningWriteAuthorizer } from '../share-widening-write-authorizer.js'
import { ShareGrantIndex } from '../share-grant-index.js'
import { ShareStore } from '../share-store.js'
import { ConceptIdFields } from '../concept-id-fields.js'
import { ShareSubjectKind } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PrivilegeAction, Principal, PrincipalKind } from '@pragmatic-tech-ai/todl-identity'

const Order = 'shop.Order'

class FakeSession
{
    public readonly rows = new Map<string, Record<string, unknown>>()
    public async Find(): Promise<readonly Record<string, unknown>[]> { return [...this.rows.values()] }
    public async Upsert(_c: string, _f: string, key: unknown, doc: Record<string, unknown>): Promise<void> { this.rows.set(String(key), doc) }
    public async Delete(): Promise<boolean> { return false }
}

class Fixture
{
    public static readonly IdFields = ConceptIdFields.From({ Model: 'm', Version: '1', Connectors: [], Bindings: [{ Concept: Order, Connector: 'c', Source: 's', IdKey: 'id', FieldMap: {}, Writable: true }] } as never)

    public static View(id: string)
    {
        return { Concept: Order, RecordKey: id, Field: (n: string) => (n === 'id' ? id : undefined) }
    }

    public static async IndexWith(right: PrivilegeAction): Promise<ShareGrantIndex>
    {
        const store = new ShareStore(new FakeSession() as never)
        await store.Grant({ concept: Order, recordId: 'o1', subject: { kind: ShareSubjectKind.Principal, id: 'u2' }, rights: [right] })
        return ShareGrantIndex.For(store, new Principal('u2', 't1', PrincipalKind.User, new Map(), []), { homeBusinessUnit: 'root', teams: [] })
    }
}

class DenyGate
{
    public constructor(private readonly canWriteField: boolean = true, private readonly innerById: boolean = false) {}
    public CreateDefaults(): readonly { field: string; value: string }[] { return [] }
    public Authorize(): boolean { return false }
    public async AuthorizeById(): Promise<boolean> { return this.innerById }
    public async Resolve(): Promise<unknown> { return undefined }
    public CanWriteField(): boolean { return this.canWriteField }
}

test('an Update share lets the holder update that one record though the inner gate denies', async () =>
{
    const gate = new ShareWideningWriteInstanceGate(new DenyGate() as never, await Fixture.IndexWith(PrivilegeAction.Update), Fixture.IdFields)
    assert.equal(gate.Authorize(PrivilegeAction.Update, Fixture.View('o1') as never), true)
    assert.equal(gate.Authorize(PrivilegeAction.Update, Fixture.View('o2') as never), false)
    assert.equal(await gate.AuthorizeById(PrivilegeAction.Update, Order, 'o1'), true)
    assert.equal(await gate.AuthorizeById(PrivilegeAction.Delete, Order, 'o1'), false)
})

test('AuthorizeById falls back to the inner gate when there is no grant, and needs no read-resolution when there is', async () =>
{
    const index = await Fixture.IndexWith(PrivilegeAction.Update)
    const allowingInner = new ShareWideningWriteInstanceGate(new DenyGate(true, true) as never, index, Fixture.IdFields)
    assert.equal(await allowingInner.AuthorizeById(PrivilegeAction.Delete, Order, 'o1'), true)
    assert.equal(await allowingInner.AuthorizeById(PrivilegeAction.Update, Order, 'o2'), true)
    const denyingInner = new ShareWideningWriteInstanceGate(new DenyGate(true, false) as never, index, Fixture.IdFields)
    assert.equal(await denyingInner.AuthorizeById(PrivilegeAction.Update, Order, 'o2'), false)
})

test('a view without RecordKey falls back to the id field', async () =>
{
    const gate = new ShareWideningWriteInstanceGate(new DenyGate() as never, await Fixture.IndexWith(PrivilegeAction.Update), Fixture.IdFields)
    const view = { Concept: Order, Field: (n: string) => (n === 'id' ? 'o1' : undefined) }
    assert.equal(gate.Authorize(PrivilegeAction.Update, view as never), true)
})

test('a view with neither RecordKey nor a resolvable id is denied', async () =>
{
    const gate = new ShareWideningWriteInstanceGate(new DenyGate() as never, await Fixture.IndexWith(PrivilegeAction.Update), Fixture.IdFields)
    const view = { Concept: Order, Field: () => undefined }
    assert.equal(gate.Authorize(PrivilegeAction.Update, view as never), false)
})

test('CanWriteField is not share-widened: it delegates to the inner gate', async () =>
{
    const index = await Fixture.IndexWith(PrivilegeAction.Update)
    const denying = new ShareWideningWriteInstanceGate(new DenyGate(false) as never, index, Fixture.IdFields)
    const allowing = new ShareWideningWriteInstanceGate(new DenyGate(true) as never, index, Fixture.IdFields)
    assert.equal(denying.CanWriteField(Order, 'total', PrivilegeAction.Update), false)
    assert.equal(allowing.CanWriteField(Order, 'total', PrivilegeAction.Update), true)
})

test('coarse authorizer passes a share-only writer for the granted action only', async () =>
{
    const inner = { Allows(): boolean { return false } }
    const auth = new ShareWideningWriteAuthorizer(inner, await Fixture.IndexWith(PrivilegeAction.Update))
    assert.equal(auth.Allows(Order, PrivilegeAction.Update), true)
    assert.equal(auth.Allows(Order, PrivilegeAction.Delete), false)
})
