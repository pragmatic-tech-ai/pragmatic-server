import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdpLoginThrottle } from '../idp-login-throttle.js';

class IdpLoginThrottleTestFixture
{
    public static readonly Tenant = 'tenant-1';
    public static readonly EmailA = 'a@x';
    public static readonly EmailB = 'b@x';
    public static readonly Ip1 = '10.0.0.1';
    public static readonly Ip2 = '10.0.0.2';
    public static readonly MinuteMs = 60 * 1000;
    public static readonly DefaultAttempts = 3;
    public static readonly DefaultWindowMs = 15 * 60 * 1000;
    public static readonly DefaultLockoutMs = 30 * 60 * 1000;
    public static readonly SmallMaxKeys = 5;
    public static readonly SprayCount = 50;

    public clock = 1000000;

    public Make(maxKeys?: number): IdpLoginThrottle
    {
        return new IdpLoginThrottle({ maxKeys, now: () => this.clock });
    }

    public Fail(throttle: IdpLoginThrottle, times: number, email: string = IdpLoginThrottleTestFixture.EmailA, ip: string = IdpLoginThrottleTestFixture.Ip1): void
    {
        for (let i = 0; i < times; i++)
        {
            throttle.RecordFailure(IdpLoginThrottleTestFixture.Tenant, email, ip);
        }
    }

    public Check(throttle: IdpLoginThrottle, email: string = IdpLoginThrottleTestFixture.EmailA, ip: string = IdpLoginThrottleTestFixture.Ip1): { allowed: boolean; retryAfterMs: number }
    {
        return throttle.CheckAllowed(IdpLoginThrottleTestFixture.Tenant, email, ip);
    }
}

test('maxAttempts-1 failures stay allowed; the maxAttempts-th locks', () =>
{
    const f = new IdpLoginThrottleTestFixture();
    const t = f.Make();
    f.Fail(t, IdpLoginThrottleTestFixture.DefaultAttempts - 1);
    assert.equal(f.Check(t).allowed, true);
    f.Fail(t, 1);
    const d = f.Check(t);
    assert.equal(d.allowed, false);
    assert.ok(d.retryAfterMs > 0);
});

test('stays denied during lockout', () =>
{
    const f = new IdpLoginThrottleTestFixture();
    const t = f.Make();
    f.Fail(t, IdpLoginThrottleTestFixture.DefaultAttempts);
    f.clock += IdpLoginThrottleTestFixture.DefaultLockoutMs - IdpLoginThrottleTestFixture.MinuteMs;
    const d = f.Check(t);
    assert.equal(d.allowed, false);
    assert.equal(d.retryAfterMs, IdpLoginThrottleTestFixture.MinuteMs);
});

test('allowed again after lockout with a fresh window', () =>
{
    const f = new IdpLoginThrottleTestFixture();
    const t = f.Make();
    f.Fail(t, IdpLoginThrottleTestFixture.DefaultAttempts);
    f.clock += IdpLoginThrottleTestFixture.DefaultLockoutMs + 1;
    assert.equal(f.Check(t).allowed, true);
    f.Fail(t, IdpLoginThrottleTestFixture.DefaultAttempts - 1);
    assert.equal(f.Check(t).allowed, true);
    f.Fail(t, 1);
    assert.equal(f.Check(t).allowed, false);
});

test('Clear wipes the counter', () =>
{
    const f = new IdpLoginThrottleTestFixture();
    const t = f.Make();
    f.Fail(t, IdpLoginThrottleTestFixture.DefaultAttempts);
    t.Clear(IdpLoginThrottleTestFixture.Tenant, IdpLoginThrottleTestFixture.EmailA, IdpLoginThrottleTestFixture.Ip1);
    assert.equal(f.Check(t).allowed, true);
    assert.equal(t.Size(), 0);
});

test('a lock leaves other emails and other ips allowed', () =>
{
    const f = new IdpLoginThrottleTestFixture();
    const t = f.Make();
    f.Fail(t, IdpLoginThrottleTestFixture.DefaultAttempts);
    assert.equal(f.Check(t).allowed, false);
    assert.equal(f.Check(t, IdpLoginThrottleTestFixture.EmailB, IdpLoginThrottleTestFixture.Ip1).allowed, true);
    assert.equal(f.Check(t, IdpLoginThrottleTestFixture.EmailA, IdpLoginThrottleTestFixture.Ip2).allowed, true);
});

test('a lock is scoped to the tenant', () =>
{
    const f = new IdpLoginThrottleTestFixture();
    const t = f.Make();
    f.Fail(t, IdpLoginThrottleTestFixture.DefaultAttempts);
    assert.equal(t.CheckAllowed('tenant-2', IdpLoginThrottleTestFixture.EmailA, IdpLoginThrottleTestFixture.Ip1).allowed, true);
});

test('spraying distinct keys never evicts a locked entry', () =>
{
    const f = new IdpLoginThrottleTestFixture();
    const t = f.Make(IdpLoginThrottleTestFixture.SmallMaxKeys);
    f.Fail(t, IdpLoginThrottleTestFixture.DefaultAttempts);
    for (let i = 0; i < IdpLoginThrottleTestFixture.SprayCount; i++)
    {
        f.Fail(t, 1, 'spray' + i + '@x', IdpLoginThrottleTestFixture.Ip1);
    }
    assert.equal(f.Check(t).allowed, false);
    assert.ok(t.Size() <= IdpLoginThrottleTestFixture.SmallMaxKeys);
});

test('defaults are 3 attempts / 15 min window / 30 min lockout', () =>
{
    const f = new IdpLoginThrottleTestFixture();
    const t = f.Make();
    f.Fail(t, IdpLoginThrottleTestFixture.DefaultAttempts);
    assert.equal(f.Check(t).retryAfterMs, IdpLoginThrottleTestFixture.DefaultLockoutMs);
    // window: 2 failures, wait past the window, 1 more must not lock
    const f2 = new IdpLoginThrottleTestFixture();
    const t2 = f2.Make();
    f2.Fail(t2, IdpLoginThrottleTestFixture.DefaultAttempts - 1);
    f2.clock += IdpLoginThrottleTestFixture.DefaultWindowMs;
    f2.Fail(t2, 1);
    assert.equal(f2.Check(t2).allowed, true);
});
