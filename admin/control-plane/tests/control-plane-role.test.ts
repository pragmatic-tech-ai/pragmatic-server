import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ControlPlaneRole, ControlPlaneRoleInvalidError, ControlPlaneRoles, ControlPlaneStart, EdgeRoleRefusedError, type IControlPlaneListenerStarts } from '../control-plane-role.js'
import { AgentChannelHost } from '../agent-channel-host.js'
import { ControlPlaneServer } from '../server.js'

/** Records which listeners the start sequence asked for, in order. */
class RecordingListeners implements IControlPlaneListenerStarts
{
    public static readonly Operator = 'operator'
    public static readonly Channel = 'channel'
    public static readonly Tenant = 'tenant'
    public static readonly Internal = 'internal'

    public readonly Started: string[] = []

    public async StartOperatorHost(): Promise<void>
    {
        this.Started.push(RecordingListeners.Operator)
    }

    public async StartAgentChannel(): Promise<void>
    {
        this.Started.push(RecordingListeners.Channel)
    }

    public async StartInternalApi(): Promise<void>
    {
        this.Started.push(RecordingListeners.Internal)
    }

    public async StartTenantPlane(): Promise<void>
    {
        this.Started.push(RecordingListeners.Tenant)
    }

    public static async StartedBy(role: ControlPlaneRole): Promise<string[]>
    {
        const listeners = new RecordingListeners()
        await new ControlPlaneStart(role).Run(listeners)
        return listeners.Started
    }
}

/** Inert stand-ins for what the agent channel is composed over: composing never touches them. */
class ChannelParts
{
    public static ChannelOf(role: ControlPlaneRole): AgentChannelHost | undefined
    {
        return ControlPlaneServer.AgentChannelOf(role, { Handle: async () => ({ Status: 204 }), ServesConsole: () => true })
    }
}

describe('control-plane start sequence', () =>
{
    it('all starts the operator host, then the agent channel, then the tenant plane', async () =>
    {
        const R = RecordingListeners
        assert.deepEqual(await R.StartedBy(ControlPlaneRole.All), [R.Operator, R.Internal, R.Channel, R.Tenant])
    })

    it('admin starts everything except the agent channel', async () =>
    {
        const R = RecordingListeners
        assert.deepEqual(await R.StartedBy(ControlPlaneRole.Admin), [R.Operator, R.Internal, R.Tenant])
    })

    it('only roles that start the agent channel compose its host (and the console advert receiver behind it)', () =>
    {
        for (const role of ControlPlaneRoles.Known)
        {
            assert.equal(ControlPlaneRoles.ServesAgentChannel(role), ControlPlaneRoles.ListenersOf(role).AgentChannel, role)
        }
        assert.equal(ControlPlaneRoles.ServesAgentChannel(ControlPlaneRole.Admin), false)
        assert.equal(ChannelParts.ChannelOf(ControlPlaneRole.Admin), undefined)
        assert.ok(ChannelParts.ChannelOf(ControlPlaneRole.All) instanceof AgentChannelHost)
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
        assert.deepEqual(ControlPlaneRoles.ListenersOf(ControlPlaneRole.All), { OperatorHost: true, AgentChannel: true, TenantPlane: true, InternalApi: true })
    })

    it('edge is recognised but refused: the edge runs its own entry, never the console', () =>
    {
        const role = ControlPlaneRoles.Of({ PRAGMATIC_CONTROL_PLANE_ROLE: 'edge' })
        assert.equal(role, ControlPlaneRole.Edge)
        assert.throws(() => ControlPlaneRoles.RequireConsole(role), (e: Error) => e instanceof EdgeRoleRefusedError && /pragmatic-platform-edged/.test(e.message))
        assert.doesNotThrow(() => ControlPlaneRoles.RequireConsole(ControlPlaneRole.Admin))
        assert.doesNotThrow(() => ControlPlaneRoles.RequireConsole(ControlPlaneRole.All))
    })

    it('admin composes the operator host and not the agent channel', () =>
    {
        const role = ControlPlaneRoles.Of({ PRAGMATIC_CONTROL_PLANE_ROLE: 'admin' })
        assert.equal(role, ControlPlaneRole.Admin)
        assert.deepEqual(ControlPlaneRoles.ListenersOf(role), { OperatorHost: true, AgentChannel: false, TenantPlane: true, InternalApi: true })
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
})
