import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RateLimitScope, RateLimitDecision, NullRateLimiter, TokenBucketRateLimiter } from '../rate-limiter.js'

class FakeClock
{
    public Now = 0
    public readonly Tick = (): number => this.Now
}

test('NullRateLimiter always allows', () =>
{
    const limiter = new NullRateLimiter()
    for (let i = 0; i < 100; i++)
    {
        assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }).Allowed, true)
    }
})

test('a burst of Burst requests is allowed and the next is rejected with a positive retry hint', () =>
{
    const clock = new FakeClock()
    const limiter = new TokenBucketRateLimiter({ perTenant: { Rps: 1, Burst: 5 } }, clock.Tick)
    for (let i = 0; i < 5; i++)
    {
        assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }).Allowed, true, `request ${i}`)
    }
    const rejected = limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' })
    assert.equal(rejected.Allowed, false)
    assert.ok(rejected.RetryAfterMs > 0)
})

test('a drained bucket refills at the configured steady rate via the injected clock', () =>
{
    const clock = new FakeClock()
    const limiter = new TokenBucketRateLimiter({ perTenant: { Rps: 2, Burst: 2 } }, clock.Tick)
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }).Allowed, true)
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }).Allowed, true)
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }).Allowed, false)
    clock.Now = 500
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }).Allowed, true)
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }).Allowed, false)
})

test('tenant and principal buckets are independent', () =>
{
    const clock = new FakeClock()
    const limiter = new TokenBucketRateLimiter({ perTenant: { Rps: 1, Burst: 1 }, perPrincipal: { Rps: 1, Burst: 1 } }, clock.Tick)
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }).Allowed, true)
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }).Allowed, false)
    assert.equal(limiter.Check({ scope: RateLimitScope.Principal, tenant: 't1', key: 'p1' }).Allowed, true)
})

test('two different tenants have independent buckets', () =>
{
    const clock = new FakeClock()
    const limiter = new TokenBucketRateLimiter({ perTenant: { Rps: 1, Burst: 1 } }, clock.Tick)
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }).Allowed, true)
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't2', key: 't2' }).Allowed, true)
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 't1', key: 't1' }).Allowed, false)
})

test('a scope with no configured settings always allows', () =>
{
    const clock = new FakeClock()
    const limiter = new TokenBucketRateLimiter({ perTenant: { Rps: 1, Burst: 1 } }, clock.Tick)
    for (let i = 0; i < 10; i++)
    {
        assert.equal(limiter.Check({ scope: RateLimitScope.Principal, tenant: 't1', key: 'p1' }).Allowed, true)
    }
})

test('Allow and Reject factory invariants', () =>
{
    assert.equal(RateLimitDecision.Allow().Allowed, true)
    assert.equal(RateLimitDecision.Allow().RetryAfterMs, 0)
    assert.equal(RateLimitDecision.Reject(250).Allowed, false)
    assert.equal(RateLimitDecision.Reject(250).RetryAfterMs, 250)
})

test('the same principal id under two tenants has independent buckets', () =>
{
    const clock = new FakeClock()
    const limiter = new TokenBucketRateLimiter({ perPrincipal: { Rps: 1, Burst: 1 } }, clock.Tick)
    assert.equal(limiter.Check({ scope: RateLimitScope.Principal, tenant: 't1', key: 'alice' }).Allowed, true)
    assert.equal(limiter.Check({ scope: RateLimitScope.Principal, tenant: 't1', key: 'alice' }).Allowed, false)
    assert.equal(limiter.Check({ scope: RateLimitScope.Principal, tenant: 't2', key: 'alice' }).Allowed, true)
})

test('principal composite keys cannot collide across (tenant, key) pairs', () =>
{
    const clock = new FakeClock()
    const limiter = new TokenBucketRateLimiter({ perPrincipal: { Rps: 1, Burst: 1 } }, clock.Tick)
    assert.equal(limiter.Check({ scope: RateLimitScope.Principal, tenant: 'a', key: 'b:c' }).Allowed, true)
    assert.equal(limiter.Check({ scope: RateLimitScope.Principal, tenant: 'a:b', key: 'c' }).Allowed, true)
})

test('idle buckets are evicted past the threshold and a post-eviction request is a fresh full bucket', () =>
{
    const clock = new FakeClock()
    const limiter = new TokenBucketRateLimiter({ perTenant: { Rps: 1, Burst: 1 } }, clock.Tick, 2)
    for (const id of ['a', 'b', 'c'])
    {
        limiter.Check({ scope: RateLimitScope.Tenant, tenant: id, key: id })
    }
    assert.equal(limiter.BucketCount(RateLimitScope.Tenant), 3)
    clock.Now = 5000
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 'a', key: 'a' }).Allowed, true)
    assert.equal(limiter.BucketCount(RateLimitScope.Tenant), 1)
    assert.equal(limiter.Check({ scope: RateLimitScope.Tenant, tenant: 'b', key: 'b' }).Allowed, true)
})

test('a backwards-moving clock never rewinds refill state', () =>
{
    const clock = new FakeClock()
    clock.Now = 1000
    const limiter = new TokenBucketRateLimiter({ perTenant: { Rps: 1, Burst: 1 } }, clock.Tick)
    const req = { scope: RateLimitScope.Tenant, tenant: 't', key: 't' }
    assert.equal(limiter.Check(req).Allowed, true)
    clock.Now = 0
    assert.equal(limiter.Check(req).Allowed, false)
    clock.Now = 1500
    assert.equal(limiter.Check(req).Allowed, false)
    clock.Now = 2000
    assert.equal(limiter.Check(req).Allowed, true)
})

test('invalid config throws at construction', () =>
{
    const bad = [{ Rps: 0, Burst: 1 }, { Rps: -1, Burst: 1 }, { Rps: Infinity, Burst: 1 }, { Rps: NaN, Burst: 1 }, { Rps: 1, Burst: 0 }, { Rps: 1, Burst: 0.5 }, { Rps: 1, Burst: NaN }]
    for (const settings of bad)
    {
        assert.throws(() => new TokenBucketRateLimiter({ perTenant: settings }))
        assert.throws(() => new TokenBucketRateLimiter({ perPrincipal: settings }))
    }
})

test('tokens cap at Burst after a long idle advance', () =>
{
    const clock = new FakeClock()
    const limiter = new TokenBucketRateLimiter({ perTenant: { Rps: 1, Burst: 3 } }, clock.Tick)
    const req = { scope: RateLimitScope.Tenant, tenant: 't', key: 't' }
    limiter.Check(req)
    clock.Now = 1000000
    for (let i = 0; i < 3; i++)
    {
        assert.equal(limiter.Check(req).Allowed, true)
    }
    assert.equal(limiter.Check(req).Allowed, false)
})

test('fractional refill: 250ms rejects, 500ms allows exactly once at Rps=2', () =>
{
    const clock = new FakeClock()
    const limiter = new TokenBucketRateLimiter({ perTenant: { Rps: 2, Burst: 1 } }, clock.Tick)
    const req = { scope: RateLimitScope.Tenant, tenant: 't', key: 't' }
    assert.equal(limiter.Check(req).Allowed, true)
    clock.Now = 250
    assert.equal(limiter.Check(req).Allowed, false)
    clock.Now = 500
    assert.equal(limiter.Check(req).Allowed, true)
    assert.equal(limiter.Check(req).Allowed, false)
})

test('RetryAfterMs is exact for an empty bucket', () =>
{
    const clock = new FakeClock()
    const limiter = new TokenBucketRateLimiter({ perTenant: { Rps: 1, Burst: 1 } }, clock.Tick)
    const req = { scope: RateLimitScope.Tenant, tenant: 't', key: 't' }
    limiter.Check(req)
    assert.equal(limiter.Check(req).RetryAfterMs, 1000)
})
