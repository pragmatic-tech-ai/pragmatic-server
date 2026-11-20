import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { AppSessionService } from '@pragmatic-tech-ai/pragmatic-app-shell'
import type { ControlPlaneClient } from '../../api-client.js'
import { OperatorContext } from '../../operator-context.js'
import { PortalSessionService } from '../portal-session-service.js'
import { PortalTestHost } from './portal-test-fixtures.js'

// The console's part of the session: the operator role from the session's app_roles claim. Expiry, logout and the
// own-password change are the shell's AppSessionService (tested in pragmatic-app-shell).
describe('PortalSessionService', () =>
{
    it('is the shell session service', () =>
    {
        assert.ok(new PortalSessionService(new ServiceProvider()) instanceof AppSessionService)
    })

    it('before Initialize it cannot mutate and says why', () =>
    {
        const session = new PortalSessionService(new ServiceProvider())
        assert.equal(session.CanMutate, false)
        assert.equal(session.DeniedReason, 'Not signed in')
        assert.equal(session.ReadOnlyNotice, '')
    })

    it('Initialize raises the role facts from their previous values', () =>
    {
        const session = new PortalSessionService(new ServiceProvider())
        const seen: Array<[string, unknown, unknown]> = []
        for (const name of ['DeniedReason', 'CanMutate', 'RoleLabel', 'Email'])
        {
            session.PropertyChanged(name).subscribe(e => seen.push([name, e.oldValue, e.newValue]))
        }
        session.Initialize(PortalTestHost.Equip({} as ControlPlaneClient), PortalTestHost.SessionFor(OperatorContext.FullWireRole), { Reload: () => { } })
        assert.deepEqual(seen.sort(), [
            ['CanMutate', false, true],
            ['DeniedReason', 'Not signed in', ''],
            ['Email', '', PortalTestHost.Email],
            ['RoleLabel', '', 'Operator'],
        ])
    })

    it('an operator.read-only session is an Observer with a denied reason and a read-only notice', () =>
    {
        const host = new PortalTestHost({} as ControlPlaneClient, OperatorContext.ReadOnlyWireRole)
        assert.deepEqual(host.Session.AppRoles, ['operator.read-only'])
        assert.equal(host.Session.CanMutate, false)
        assert.equal(host.Session.DeniedReason, 'Needs the Operator role. Ask your operator lead.')
        assert.equal(host.Session.ReadOnlyNotice, 'Read-only: you are signed in as Observer.')
        assert.equal(host.Session.RoleLabel, 'Observer')
        assert.equal(host.Session.Email, PortalTestHost.Email)
    })

    it('an operator.full session is an Operator with no denied reason and no notice', () =>
    {
        const host = new PortalTestHost({} as ControlPlaneClient)
        assert.equal(host.Session.CanMutate, true)
        assert.equal(host.Session.DeniedReason, '')
        assert.equal(host.Session.ReadOnlyNotice, '')
        assert.equal(host.Session.RoleLabel, 'Operator')
    })

    it('offers Change password (the console has an own-password path)', () =>
    {
        const host = new PortalTestHost({} as ControlPlaneClient)
        assert.equal(host.Session.ShowsChangePassword, true)
    })
})
