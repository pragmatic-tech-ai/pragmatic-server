import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OperatorSocketRegistry, type WebSocketLike } from '../operator-socket-registry.js'

class FakeSocket implements WebSocketLike
{
    public Closed = false
    private readonly handlers = new Map<string, Array<() => void>>()

    public close(): void
    {
        this.Closed = true
    }

    public on(event: string, cb: () => void): void
    {
        const list = this.handlers.get(event) ?? []
        list.push(cb)
        this.handlers.set(event, list)
    }

    public Emit(event: string): void
    {
        for (const cb of this.handlers.get(event) ?? [])
        {
            cb()
        }
    }
}

test('socket close event deregisters it and drops the empty token', () =>
{
    const r = new OperatorSocketRegistry()
    const s = new FakeSocket()
    r.Add('t1', s)
    assert.equal(r.Size(), 1)
    s.Emit('close')
    assert.equal(r.Size(), 0)
    assert.deepEqual(r.Tokens(), [])
})

test('CloseToken closes all sockets under the token and removes the entry', () =>
{
    const r = new OperatorSocketRegistry()
    const a = new FakeSocket()
    const b = new FakeSocket()
    const other = new FakeSocket()
    r.Add('t1', a)
    r.Add('t1', b)
    r.Add('t2', other)
    r.CloseToken('t1')
    assert.ok(a.Closed && b.Closed)
    assert.equal(other.Closed, false)
    assert.deepEqual(r.Tokens(), ['t2'])
    assert.equal(r.Size(), 1)
})

test('All enumerates across tokens', () =>
{
    const r = new OperatorSocketRegistry()
    const a = new FakeSocket()
    const b = new FakeSocket()
    r.Add('t1', a)
    r.Add('t2', b)
    assert.deepEqual([...r.All()], [a, b])
})

test('CloseToken on unknown token is a no-op', () =>
{
    const r = new OperatorSocketRegistry()
    r.CloseToken('x')
    assert.equal(r.Size(), 0)
})

test('partial close leaves the remaining sockets registered', () =>
{
    const r = new OperatorSocketRegistry()
    const a = new FakeSocket()
    const b = new FakeSocket()
    const c = new FakeSocket()
    r.Add('t1', a)
    r.Add('t1', b)
    r.Add('t1', c)
    a.Emit('close')
    assert.equal(r.Size(), 2)
    assert.deepEqual(r.Tokens(), ['t1'])
    b.Emit('close')
    assert.equal(r.Size(), 1)
    assert.deepEqual([...r.All()], [c])
})

test('CloseToken closes every socket of a multi-socket token', () =>
{
    const r = new OperatorSocketRegistry()
    const socks = [new FakeSocket(), new FakeSocket(), new FakeSocket()]
    for (const s of socks)
    {
        r.Add('t1', s)
    }
    r.CloseToken('t1')
    assert.ok(socks.every(s => s.Closed))
    assert.equal(r.Size(), 0)
})
