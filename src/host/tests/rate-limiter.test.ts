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
