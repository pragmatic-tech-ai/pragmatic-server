import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AuditThrottle } from '../audit-throttle.js'

class AuditThrottleHarness
{
    public static readonly IpA = '10.0.0.1'
    public static readonly IpB = '10.0.0.2'
    public static readonly MaxHits = 2
    public static readonly WindowMs = 1000
    public static readonly LockoutMs = 5000
    public static readonly Step = 10

    public clock = 0

    public Make(maxKeys?: number): AuditThrottle
    {
        return new AuditThrottle({
            maxHits: AuditThrottleHarness.MaxHits,
            windowMs: AuditThrottleHarness.WindowMs,
            lockoutMs: AuditThrottleHarness.LockoutMs,
            maxKeys,
            now: () => this.clock,
        })
    }

    public Hit(throttle: AuditThrottle, ip: string, times: number): void
    {
        for (let i = 0; i < times; i++)
        {
            throttle.RecordHit(ip)
        }
    }
}

describe('AuditThrottle', () =>
{
    it('allows under threshold', () =>
    {
        const h = new AuditThrottleHarness()
        const t = h.Make()
        h.Hit(t, AuditThrottleHarness.IpA, 2)
        assert.equal(t.CheckAllowed(AuditThrottleHarness.IpA).allowed, true)
    })

    it('locks at threshold', () =>
    {
        const h = new AuditThrottleHarness()
        const t = h.Make()
        h.Hit(t, AuditThrottleHarness.IpA, 3)
        const d = t.CheckAllowed(AuditThrottleHarness.IpA)
        assert.equal(d.allowed, false)
        assert.ok(d.retryAfterMs > 0)
    })

    it('unlocks after lockout', () =>
    {
        const h = new AuditThrottleHarness()
        const t = h.Make()
        h.Hit(t, AuditThrottleHarness.IpA, 3)
        h.clock += AuditThrottleHarness.LockoutMs + AuditThrottleHarness.Step
        assert.equal(t.CheckAllowed(AuditThrottleHarness.IpA).allowed, true)
    })

    it('resets the window so spread hits never lock', () =>
    {
        const h = new AuditThrottleHarness()
        const t = h.Make()
        for (let i = 0; i < 6; i++)
        {
            t.RecordHit(AuditThrottleHarness.IpA)
            h.clock += AuditThrottleHarness.WindowMs + AuditThrottleHarness.Step
        }
        assert.equal(t.CheckAllowed(AuditThrottleHarness.IpA).allowed, true)
    })

    it('is bounded by maxKeys', () =>
    {
        const h = new AuditThrottleHarness()
        const t = h.Make(1)
        h.Hit(t, AuditThrottleHarness.IpA, 3)
        assert.equal(t.CheckAllowed(AuditThrottleHarness.IpA).allowed, false)
        t.RecordHit(AuditThrottleHarness.IpB)
        assert.equal(t.CheckAllowed(AuditThrottleHarness.IpA).allowed, true)
    })

    it('isolates ips', () =>
    {
        const h = new AuditThrottleHarness()
        const t = h.Make()
        h.Hit(t, AuditThrottleHarness.IpA, 3)
        assert.equal(t.CheckAllowed(AuditThrottleHarness.IpA).allowed, false)
        assert.equal(t.CheckAllowed(AuditThrottleHarness.IpB).allowed, true)
    })
})
