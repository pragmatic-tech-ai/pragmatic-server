import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { ApiError, type ControlPlaneClient } from '../../api-client.js'
import { OperatorContext } from '../../operator-context.js'
import { PortalSessionService } from '../portal-session-service.js'
import { PortalTestHost, Tick } from './portal-test-fixtures.js'

class LogoutClient
{
    public Calls = 0

    public constructor(private readonly failure?: Error)
    {
    }

    public async Logout(): Promise<void>
    {
        this.Calls++
        if (this.failure !== undefined)
        {
            throw this.failure
        }
    }

    public AsClient(): ControlPlaneClient
    {
        return this as unknown as ControlPlaneClient
    }
}

describe('PortalSessionService', () =>
{
    it('before Initialize it cannot mutate and says why', () =>
    {
        const session = new PortalSessionService(new ServiceProvider())
        assert.equal(session.CanMutate, false)
        assert.equal(session.DeniedReason, 'Not signed in')
        assert.equal(session.ReadOnlyNotice, '')
    })

    it('Initialize raises changes from the previous values', () =>
    {
        const session = new PortalSessionService(new ServiceProvider())
        const seen: Array<[unknown, unknown]> = []
        session.PropertyChanged('DeniedReason').subscribe(e => seen.push([e.oldValue, e.newValue]))
        session.Initialize(new LogoutClient().AsClient(), 'a@b', OperatorContext.FromWire(OperatorContext.FullWireRole), { Reload: () => { } })
        assert.deepEqual(seen, [['Not signed in', '']])
    })

    it('an Observer gets a denied reason and a read-only notice', () =>
    {
        const host = new PortalTestHost(new LogoutClient().AsClient(), OperatorContext.ReadOnlyWireRole)
        assert.equal(host.Session.CanMutate, false)
        assert.notEqual(host.Session.DeniedReason, '')
        assert.notEqual(host.Session.ReadOnlyNotice, '')
        assert.equal(host.Session.RoleLabel, 'Observer')
        assert.equal(host.Session.Email, PortalTestHost.Email)
    })

    it('an Operator has no denied reason and no notice', () =>
    {
        const host = new PortalTestHost(new LogoutClient().AsClient())
        assert.equal(host.Session.CanMutate, true)
        assert.equal(host.Session.DeniedReason, '')
        assert.equal(host.Session.ReadOnlyNotice, '')
        assert.equal(host.Session.RoleLabel, 'Operator')
    })

    it('Expire reloads the page at most once', () =>
    {
        const host = new PortalTestHost(new LogoutClient().AsClient())
        host.Session.Expire()
        host.Session.Expire()
        assert.equal(host.Reloader.Count, 1)
    })

    it('LogoutCommand logs out and then reloads once', async () =>
    {
        const client = new LogoutClient()
        const host = new PortalTestHost(client.AsClient())
        host.Session.LogoutCommand.Execute()
        await Tick.Next()
        assert.equal(client.Calls, 1)
        assert.equal(host.Reloader.Count, 1)
        assert.equal(host.Session.LogoutError, '')
    })

    it('a failed logout stays on the page and reports the error', async () =>
    {
        const host = new PortalTestHost(new LogoutClient(new ApiError(500, 'server down')).AsClient())
        host.Session.LogoutCommand.Execute()
        await Tick.Next()
        assert.equal(host.Reloader.Count, 0)
        assert.equal(host.Session.LogoutError, 'server down')
    })

    it('a 401 on logout means already signed out: reloads', async () =>
    {
        const host = new PortalTestHost(new LogoutClient(new ApiError(401, 'unauthorized')).AsClient())
        host.Session.LogoutCommand.Execute()
        await Tick.Next()
        assert.equal(host.Reloader.Count, 1)
        assert.equal(host.Session.LogoutError, '')
    })
})
