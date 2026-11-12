import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ControlPlaneRole, ControlPlaneRoleInvalidError, ControlPlaneRoles, ControlPlaneStart, EdgeRoleWithoutChannelError, type IControlPlaneListenerStarts } from '../control-plane-role.js'

/** Records which listeners the start sequence asked for, in order. */
class RecordingListeners implements IControlPlaneListenerStarts
{
    public readonly Started: string[] = []

    public async StartOperatorHost(): Promise<void>
    {
        this.Started.push('operator')
    }

    public async StartAgentChannel(): Promise<void>
    {
        this.Started.push('channel')
    }

    public async StartTenantPlane(): Promise<void>
    {
        this.Started.push('tenant')
    }

    public static async StartedBy(role: ControlPlaneRole): Promise<string[]>
    {
        const listeners = new RecordingListeners()
        await new ControlPlaneStart(role).Run(listeners)
        return listeners.Started
    }
}

describe('control-plane start sequence', () =>
{
    it('all starts the operator host, then the agent channel, then the tenant plane', async () =>
    {
        assert.deepEqual(await RecordingListeners.StartedBy(ControlPlaneRole.All), ['operator', 'channel', 'tenant'])
    })

    it('edge starts only the agent channel', async () =>
    {
        assert.deepEqual(await RecordingListeners.StartedBy(ControlPlaneRole.Edge), ['channel'])
    })

    it('admin starts everything except the agent channel', async () =>
    {
        assert.deepEqual(await RecordingListeners.StartedBy(ControlPlaneRole.Admin), ['operator', 'tenant'])
    })

    it('only the edge skips the operator-side services', () =>
    {
        assert.equal(ControlPlaneRoles.ServesOperators(ControlPlaneRole.All), true)
        assert.equal(ControlPlaneRoles.ServesOperators(ControlPlaneRole.Admin), true)
        assert.equal(ControlPlaneRoles.ServesOperators(ControlPlaneRole.Edge), false)
    })
})

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
            assert.match(err.message, /all, edge, admin$/)
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
