import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LoginThrottle } from '../login-throttle.js'

class Clock
{
    public Time = 1000
    public readonly Now = (): number => this.Time
}

class Fixture
{
    public static readonly Email = 'Op@Example.com'
    public static readonly Ip = '10.0.0.1'
    public static readonly Max = 3
    public static readonly Window = 1000
    public static readonly Lockout = 5000

    public static Make(clock: Clock, maxKeys?: number): LoginThrottle
    {
        return new LoginThrottle({ maxAttempts: Fixture.Max, windowMs: Fixture.Window, lockoutMs: Fixture.Lockout, maxKeys, now: clock.Now })
    }

    public static Fail(t: LoginThrottle, n: number, email = Fixture.Email, ip = Fixture.Ip): void
    {
        for (let i = 0; i < n; i++)
        {
            t.RecordFailure(email, ip)
        }
    }
}

describe('LoginThrottle', () =>
{
    it('locks after maxAttempts failures and reports retryAfterMs', () =>
    {
        const clock = new Clock()
        const t = Fixture.Make(clock)
        Fixture.Fail(t, Fixture.Max - 1)
        assert.equal(t.CheckAllowed(Fixture.Email, Fixture.Ip).allowed, true)
        Fixture.Fail(t, 1)
        const d = t.CheckAllowed(Fixture.Email, Fixture.Ip)
        assert.equal(d.allowed, false)
        assert.equal(d.retryAfterMs, Fixture.Lockout)
        assert.equal(t.CheckAllowed(' op@example.com ', Fixture.Ip).allowed, false)
        assert.equal(t.CheckAllowed(Fixture.Email, '10.0.0.2').allowed, true)
    })

    it('unlocks after lockoutMs', () =>
    {
        const clock = new Clock()
        const t = Fixture.Make(clock)
        Fixture.Fail(t, Fixture.Max)
        clock.Time += Fixture.Lockout - 1
        assert.equal(t.CheckAllowed(Fixture.Email, Fixture.Ip).allowed, false)
        clock.Time += 1
        assert.equal(t.CheckAllowed(Fixture.Email, Fixture.Ip).allowed, true)
    })

    it('Clear resets the counter', () =>
    {
        const clock = new Clock()
        const t = Fixture.Make(clock)
        Fixture.Fail(t, Fixture.Max)
        t.Clear(Fixture.Email, Fixture.Ip)
        assert.equal(t.CheckAllowed(Fixture.Email, Fixture.Ip).allowed, true)
        Fixture.Fail(t, Fixture.Max - 1)
        assert.equal(t.CheckAllowed(Fixture.Email, Fixture.Ip).allowed, true)
    })

    it('failures outside windowMs do not accumulate', () =>
    {
        const clock = new Clock()
        const t = Fixture.Make(clock)
        Fixture.Fail(t, Fixture.Max - 1)
        clock.Time += Fixture.Window
        Fixture.Fail(t, Fixture.Max - 1)
        assert.equal(t.CheckAllowed(Fixture.Email, Fixture.Ip).allowed, true)
    })

    it('evicts the oldest key past maxKeys', () =>
    {
        const clock = new Clock()
        const t = Fixture.Make(clock, 2)
        Fixture.Fail(t, Fixture.Max, 'a@x', Fixture.Ip)
        Fixture.Fail(t, Fixture.Max, 'b@x', Fixture.Ip)
        Fixture.Fail(t, Fixture.Max, 'c@x', Fixture.Ip)
        assert.equal(t.CheckAllowed('a@x', Fixture.Ip).allowed, true)
        assert.equal(t.CheckAllowed('b@x', Fixture.Ip).allowed, false)
        assert.equal(t.CheckAllowed('c@x', Fixture.Ip).allowed, false)
    })

    it('prunes stale entries on access', () =>
    {
        const clock = new Clock()
        const t = Fixture.Make(clock, 3)
        Fixture.Fail(t, 1, 'a@x', Fixture.Ip)
        Fixture.Fail(t, Fixture.Max, 'b@x', Fixture.Ip)
        assert.equal(t.Size(), 2)
        clock.Time += Fixture.Window + Fixture.Lockout
        t.CheckAllowed('z@x', Fixture.Ip)
        assert.equal(t.Size(), 0)
    })

    it('evicts unlocked entries before locked ones', () =>
    {
        const clock = new Clock()
        const t = Fixture.Make(clock, 2)
        Fixture.Fail(t, Fixture.Max, 'locked@x', Fixture.Ip)
        Fixture.Fail(t, 1, 'u1@x', Fixture.Ip)
        Fixture.Fail(t, 1, 'u2@x', Fixture.Ip)
        assert.equal(t.Size(), 2)
        assert.equal(t.CheckAllowed('locked@x', Fixture.Ip).allowed, false)
    })
})
