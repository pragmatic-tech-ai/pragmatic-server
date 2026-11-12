import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ControlPlaneRole, ControlPlaneRoleInvalidError, ControlPlaneRoles, EdgeRoleWithoutChannelError } from '../control-plane-role.js'

describe('control-plane role', () =>
{
    it('defaults to all when the variable is unset or blank', () =>
    {
        assert.equal(ControlPlaneRoles.Of({}), ControlPlaneRole.All)
        assert.equal(ControlPlaneRoles.Of({ PRAGMATIC_CONTROL_PLANE_ROLE: '' }), ControlPlaneRole.All)
    })

    it('all starts the operator host, the agent channel and the tenant plane', () =>
    {
        assert.deepEqual(ControlPlaneRoles.ListenersOf(ControlPlaneRole.All), { OperatorHost: true, AgentChannel: true, TenantPlane: true })
    })

    it('edge composes the agent channel and not the operator host', () =>
    {
        const role = ControlPlaneRoles.Of({ PRAGMATIC_CONTROL_PLANE_ROLE: 'edge' })
        assert.equal(role, ControlPlaneRole.Edge)
        assert.deepEqual(ControlPlaneRoles.ListenersOf(role), { OperatorHost: false, AgentChannel: true, TenantPlane: false })
    })

    it('admin composes the operator host and not the agent channel', () =>
    {
        const role = ControlPlaneRoles.Of({ PRAGMATIC_CONTROL_PLANE_ROLE: 'admin' })
        assert.equal(role, ControlPlaneRole.Admin)
        assert.deepEqual(ControlPlaneRoles.ListenersOf(role), { OperatorHost: true, AgentChannel: false, TenantPlane: true })
    })

    it('an unknown role throws a typed error naming the variable only', () =>
    {
        assert.throws(() => ControlPlaneRoles.Of({ PRAGMATIC_CONTROL_PLANE_ROLE: 'sneaky-value' }), (err: unknown) =>
        {
            assert.ok(err instanceof ControlPlaneRoleInvalidError)
            assert.match(err.message, /PRAGMATIC_CONTROL_PLANE_ROLE/)
            assert.doesNotMatch(err.message, /sneaky-value/)
            return true
        })
    })

    it('edge without an agent-channel port refuses to start, naming the variables only', () =>
    {
        assert.throws(() => ControlPlaneRoles.RequireListener(ControlPlaneRole.Edge, false), (err: unknown) =>
        {
            assert.ok(err instanceof EdgeRoleWithoutChannelError)
            assert.match(err.message, /PRAGMATIC_AGENT_CHANNEL_PORT/)
            return true
        })
        ControlPlaneRoles.RequireListener(ControlPlaneRole.Edge, true)
        ControlPlaneRoles.RequireListener(ControlPlaneRole.All, false)
        ControlPlaneRoles.RequireListener(ControlPlaneRole.Admin, false)
    })
})
