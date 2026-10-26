import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventsTicketStore } from '../events-ticket-store.js'

class Clock
{
    public T = 1000
    public Now = (): number => this.T
}

class Ids
{
    private n = 0
    public Next = (): string => `id${this.n++}`
}

class Kit
{
    public static readonly Token = 'session-token'
    public static readonly Ttl = 100
    public static readonly DefaultMax = 10

    public static Make(clock: Clock, max: number = Kit.DefaultMax): EventsTicketStore
    {
        return new EventsTicketStore({ ttlMs: Kit.Ttl, maxTickets: max, now: clock.Now, randomId: new Ids().Next })
    }
}

test('Mint then Redeem returns the token once', () =>
{
    const s = Kit.Make(new Clock())
    const t = s.Mint(Kit.Token)
    assert.equal(s.Redeem(t), Kit.Token)
    assert.equal(s.Redeem(t), null)
})

test('expired ticket redeems to null', () =>
{
    const c = new Clock()
    const s = Kit.Make(c)
    const t = s.Mint(Kit.Token)
    c.T += Kit.Ttl + 1
    assert.equal(s.Redeem(t), null)
})

test('unknown ticket redeems to null', () =>
{
    assert.equal(Kit.Make(new Clock()).Redeem('nope'), null)
})

test('default ids are opaque and distinct', () =>
{
    const s = new EventsTicketStore()
    const a = s.Mint(Kit.Token)
    const b = s.Mint(Kit.Token)
    assert.notEqual(a, b)
    assert.ok(a.length >= 32)
})

test('bounded: oldest ticket evicted past maxTickets', () =>
{
    const s = Kit.Make(new Clock(), 2)
    const a = s.Mint('a')
    const b = s.Mint('b')
    const c = s.Mint('c')
    assert.equal(s.Redeem(a), null)
    assert.equal(s.Redeem(b), 'b')
    assert.equal(s.Redeem(c), 'c')
})
