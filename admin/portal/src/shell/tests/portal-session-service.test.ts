import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ControlPlaneClient } from '../../api-client.js'
import { OperatorContext } from '../../operator-context.js'
import { PortalTestHost } from './portal-test-fixtures.js'

class LogoutClient
{
    public Calls = 0

    public async Logout(): Promise<void>
    {
        this.Calls++
    }

    public AsClient(): ControlPlaneClient
    {
        return this as unknown as ControlPlaneClient
    }
}

class Tick
{
    public static Next(): Promise<void>
    {
        return new Promise(resolve => setImmediate(resolve))
    }
}

describe('PortalSessionService', () =>
{
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
    })
})
