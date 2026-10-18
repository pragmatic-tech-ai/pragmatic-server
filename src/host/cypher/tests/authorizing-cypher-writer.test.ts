import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cypher } from '@pragmatic-tech-ai/todl'
import type { IInstanceView, Scalar } from '@pragmatic-tech-ai/todl'
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import { AllowAllWriteInstanceGate } from '../write-instance-gate.js'
import type { IWriteInstanceGate } from '../write-instance-gate.js'
import { AuthorizingCypherWriter, WriteAuthorizationError } from '../authorizing-cypher-writer.js'

class FakeInner implements Cypher.ICypherWriter
{
    public Calls: string[] = []
    private next = 0

    public CreateNode(concept: string): string
    {
        this.Calls.push('CreateNode:' + concept)
        this.next++
        return 'new' + this.next
    }

    public SetProperty(id: string, name: string): void
    {
        this.Calls.push('Set:' + id + '.' + name)
    }

    public RemoveProperty(id: string, name: string): void
    {
        this.Calls.push('Remove:' + id + '.' + name)
    }

    public CreateRelationship(): boolean
    {
        this.Calls.push('CreateRel')
        return true
    }

    public DeleteRelationship(): boolean
    {
        this.Calls.push('DeleteRel')
        return false
    }

    public DeleteNode(id: string): void
    {
        this.Calls.push('DeleteNode:' + id)
    }

    public Begin(): void
    {
        this.Calls.push('Begin')
    }

    public Commit(): Cypher.ICypherGraph
    {
        this.Calls.push('Commit')
        return undefined as unknown as Cypher.ICypherGraph
    }

    public Rollback(): void
    {
        this.Calls.push('Rollback')
    }

    public Stats(): Cypher.CypherWriteStats
    {
        this.Calls.push('Stats')
        return new Cypher.CypherWriteStats()
    }
}

class StubGate implements IWriteInstanceGate
{
    public Seen: { action: PrivilegeAction; concept: string; secret?: Scalar }[] = []
    public DenyActions = new Set<PrivilegeAction>()
    public DenyFields = new Set<string>()
    public Defaults: { field: string; value: string }[] = []

    public CreateDefaults(): readonly { field: string; value: string }[]
    {
        return this.Defaults
    }

    public Authorize(action: PrivilegeAction, view: IInstanceView): boolean
    {
        this.Seen.push({ action, concept: view.Concept, secret: view.Field('secret') })
        return !this.DenyActions.has(action)
    }

    public async AuthorizeById(): Promise<boolean>
    {
        throw new Error('async must not be used')
    }

    public async Resolve(): Promise<IInstanceView | undefined>
    {
        throw new Error('async must not be used')
    }

    public CanWriteField(_c: string, field: string): boolean
    {
        return !this.DenyFields.has(field)
    }
}

class Fx
{
    public static Graph(nodes: Record<string, { type: string; attrs: Record<string, Scalar> }>): Cypher.ICypherGraph
    {
        return {
            Reflect: (id: string) =>
            {
                const n = nodes[id]
                if (n === undefined) return undefined
                return { type: { fullName: n.type }, node: { id }, field: (name: string) => (name in n.attrs ? { value: n.attrs[name] } : undefined) }
            },
        } as unknown as Cypher.ICypherGraph
    }

    public static Props(o: Record<string, Scalar>): ReadonlyMap<string, Scalar>
    {
        return new Map(Object.entries(o))
    }
}

const Widget = 'shop.Widget'
const Visible = { a: { type: Widget, attrs: { secret: 'S3CRET' } }, b: { type: Widget, attrs: {} } }

test('a denied Create throws WriteAuthorizationError and does not call the inner CreateNode', () =>
{
    const inner = new FakeInner()
    const gate = new StubGate()
    gate.DenyActions.add(PrivilegeAction.Create)
    const w = new AuthorizingCypherWriter(inner, gate, Fx.Graph({}))
    assert.throws(() => w.CreateNode(Widget, Fx.Props({ n: 1 })), WriteAuthorizationError)
    assert.deepEqual(inner.Calls, [])
})

test('a denied field write throws before delegating', () =>
{
    const inner = new FakeInner()
    const gate = new StubGate()
    gate.DenyFields.add('salary')
    const w = new AuthorizingCypherWriter(inner, gate, Fx.Graph(Visible))
    assert.throws(() => w.CreateNode(Widget, Fx.Props({ salary: 5 })), WriteAuthorizationError)
    assert.throws(() => w.SetProperty('a', 'salary', 5), WriteAuthorizationError)
    assert.throws(() => w.RemoveProperty('a', 'salary'), WriteAuthorizationError)
    assert.deepEqual(inner.Calls, [])
})

test('SET on a read-hidden node (graph.Reflect undefined) throws (unaddressable) with no field value in the message', () =>
{
    const inner = new FakeInner()
    const w = new AuthorizingCypherWriter(inner, new StubGate(), Fx.Graph({}))
    assert.throws(
        () => w.SetProperty('ghost', 'pw', 'TOPSECRET'),
        (e: unknown) => e instanceof WriteAuthorizationError && !e.message.includes('TOPSECRET'))
    assert.deepEqual(inner.Calls, [])
})

test('CreateRelationship to a hidden target throws; to a visible target delegates', () =>
{
    const inner = new FakeInner()
    const w = new AuthorizingCypherWriter(inner, new StubGate(), Fx.Graph(Visible))
    assert.throws(() => w.CreateRelationship('a', 'rel', 'ghost'), WriteAuthorizationError)
    assert.throws(() => w.DeleteRelationship('a', 'rel', 'ghost'), WriteAuthorizationError)
    assert.deepEqual(inner.Calls, [])
    assert.equal(w.CreateRelationship('a', 'rel', 'b'), true)
    assert.equal(w.DeleteRelationship('a', 'rel', 'b'), false)
    assert.deepEqual(inner.Calls, ['CreateRel', 'DeleteRel'])
})

test('SET on a node CREATEd earlier this query authorizes against the create, not the read graph', () =>
{
    const inner = new FakeInner()
    const gate = new StubGate()
    const w = new AuthorizingCypherWriter(inner, gate, Fx.Graph({}))
    const id = w.CreateNode(Widget, Fx.Props({ n: 1 }))
    w.SetProperty(id, 'secret', 'X')
    assert.deepEqual(inner.Calls, ['CreateNode:' + Widget, 'Set:' + id + '.secret'])
    const update = gate.Seen[gate.Seen.length - 1]
    assert.equal(update.action, PrivilegeAction.Update)
    assert.equal(update.concept, Widget)
    assert.equal(w.CreateRelationship(id, 'rel', id), true)
    w.DeleteNode(id, true)
    const del = gate.Seen[gate.Seen.length - 1]
    assert.equal(del.action, PrivilegeAction.Delete)
    assert.equal(del.secret, 'X')
})

test('SET on a created node with CanWriteField(Update) denied throws and does not call inner', () =>
{
    const inner = new FakeInner()
    const gate = new StubGate()
    const w = new AuthorizingCypherWriter(inner, gate, Fx.Graph({}))
    const id = w.CreateNode(Widget, Fx.Props({ n: 1 }))
    gate.DenyFields.add('salary')
    assert.throws(() => w.SetProperty(id, 'salary', 5), WriteAuthorizationError)
    assert.deepEqual(inner.Calls, ['CreateNode:' + Widget])
})

test('CreateRelationship whose SOURCE is Authorize-denied throws and leaves inner uncalled', () =>
{
    const inner = new FakeInner()
    const gate = new StubGate()
    gate.DenyActions.add(PrivilegeAction.Update)
    const w = new AuthorizingCypherWriter(inner, gate, Fx.Graph(Visible))
    assert.throws(() => w.CreateRelationship('a', 'rel', 'b'), WriteAuthorizationError)
    assert.deepEqual(inner.Calls, [])
})

test('a typeless reflected mirror is unaddressable (fail closed, no empty concept)', () =>
{
    const inner = new FakeInner()
    const typeless = { Reflect: () => ({ type: undefined, node: { id: 'x' }, field: () => undefined }) } as unknown as Cypher.ICypherGraph
    const w = new AuthorizingCypherWriter(inner, new StubGate(), typeless)
    assert.throws(() => w.SetProperty('x', 'n', 1), WriteAuthorizationError)
    assert.deepEqual(inner.Calls, [])
})

test('DeleteNode authorizes Delete and a denial throws before delegating', () =>
{
    const inner = new FakeInner()
    const gate = new StubGate()
    gate.DenyActions.add(PrivilegeAction.Delete)
    const w = new AuthorizingCypherWriter(inner, gate, Fx.Graph(Visible))
    assert.throws(() => w.DeleteNode('a', false), WriteAuthorizationError)
    assert.deepEqual(inner.Calls, [])
})

test('CreateNode merges gate defaults into the authorized view', () =>
{
    const inner = new FakeInner()
    const gate = new StubGate()
    gate.Defaults = [{ field: 'secret', value: 'D' }]
    const w = new AuthorizingCypherWriter(inner, gate, Fx.Graph({}))
    w.CreateNode(Widget, Fx.Props({ n: 1 }))
    assert.equal(gate.Seen[0].secret, 'D')
})

test('AllowAllWriteInstanceGate authorizes everything (no-identity dev path)', () =>
{
    const inner = new FakeInner()
    const w = new AuthorizingCypherWriter(inner, AllowAllWriteInstanceGate.Instance, Fx.Graph(Visible))
    const id = w.CreateNode(Widget, Fx.Props({ n: 1 }))
    w.SetProperty('a', 'n', 2)
    w.RemoveProperty(id, 'n')
    w.DeleteNode('b', true)
    assert.equal(inner.Calls.length, 4)
})

test('Begin/Commit/Rollback/Stats delegate to the inner writer', () =>
{
    const inner = new FakeInner()
    const w = new AuthorizingCypherWriter(inner, new StubGate(), Fx.Graph({}))
    w.Begin()
    w.Commit()
    w.Rollback()
    w.Stats()
    assert.deepEqual(inner.Calls, ['Begin', 'Commit', 'Rollback', 'Stats'])
})
