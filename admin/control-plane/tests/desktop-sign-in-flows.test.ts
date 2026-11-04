import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { DesktopSignInFlows } from '../tenant-auth/desktop-sign-in-flows.js'

/** A movable clock for the flow store. */
class FlowClock
{
    public static readonly Start = Date.parse('2026-11-04T00:00:00.000Z')
    public static readonly TenMinutesMs = 10 * 60 * 1000

    private current = FlowClock.Start

    public readonly Now = (): Date => new Date(this.current)

    public Advance(ms: number): void
    {
        this.current += ms
    }
}

class FlowKit
{
    public static readonly TenantId = 'acme'
    public static readonly RedirectUri = 'http://127.0.0.1:53111/pragmatic-desktop/callback'
    public static readonly Challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    public static readonly State = 'state-1'
    public static readonly Capacity = 1000
}

describe('DesktopSignInFlows', () =>
{
    it('a flow is single use and expires after 10 minutes', () =>
    {
        const clock = new FlowClock()
        const flows = new DesktopSignInFlows(clock.Now)
        flows.Start(FlowKit.TenantId, FlowKit.RedirectUri, FlowKit.Challenge, FlowKit.State)
        assert.deepEqual(flows.Take(FlowKit.State), { tenantId: FlowKit.TenantId, redirectUri: FlowKit.RedirectUri, bindingChallenge: FlowKit.Challenge })
        assert.equal(flows.Take(FlowKit.State), undefined)

        flows.Start(FlowKit.TenantId, FlowKit.RedirectUri, FlowKit.Challenge, FlowKit.State)
        clock.Advance(FlowClock.TenMinutesMs - 1)
        assert.notEqual(flows.Take(FlowKit.State), undefined)

        flows.Start(FlowKit.TenantId, FlowKit.RedirectUri, FlowKit.Challenge, FlowKit.State)
        clock.Advance(FlowClock.TenMinutesMs)
        assert.equal(flows.Take(FlowKit.State), undefined)
    })

    it('an unknown state yields nothing', () =>
    {
        assert.equal(new DesktopSignInFlows().Take('never-started'), undefined)
    })

    it('keeps at most 1000 flows, evicting the oldest', () =>
    {
        const flows = new DesktopSignInFlows()
        for (let i = 0; i <= FlowKit.Capacity; i++)
        {
            flows.Start(FlowKit.TenantId, FlowKit.RedirectUri, FlowKit.Challenge, FlowKit.State + i)
        }
        assert.equal(flows.Take(FlowKit.State + 0), undefined)
        assert.notEqual(flows.Take(FlowKit.State + 1), undefined)
        assert.notEqual(flows.Take(FlowKit.State + FlowKit.Capacity), undefined)
    })
})
