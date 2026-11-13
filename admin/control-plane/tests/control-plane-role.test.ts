import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ControlPlaneRole, ControlPlaneRoleInvalidError, ControlPlaneRoles, ControlPlaneStart, EdgeRoleWithoutChannelError, type IControlPlaneListenerStarts } from '../control-plane-role.js'
import { AgentChannelHost } from '../agent-channel-host.js'
import type { ConsoleAdvertRegistry } from '../console-advert-registry.js'
import type { ConsoleOwnerResets } from '../console-owner-resets.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import type { PlatformDirectory } from '../platform-directory.js'
import type { PlatformEmailDomains } from '../platform-email-domains.js'
import { ControlPlaneServer } from '../server.js'

/** Records which listeners the start sequence asked for, in order. */
class RecordingListeners implements IControlPlaneListenerStarts
{
    public static readonly Operator = 'operator'
    public static readonly Channel = 'channel'
    public static readonly Tenant = 'tenant'

    public readonly Started: string[] = []

    public async StartOperatorHost(): Promise<void>
    {
        this.Started.push(RecordingListeners.Operator)
    }

    public async StartAgentChannel(): Promise<void>
    {
        this.Started.push(RecordingListeners.Channel)
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
        return ControlPlaneServer.AgentChannelOf(role, {} as PlatformDeploymentRegistry, {} as PlatformDirectory, {} as ConsoleAdvertRegistry,
            {} as ConsoleOwnerResets, {} as PlatformEmailDomains)
    }
}

describe('control-plane start sequence', () =>
{
    it('all starts the operator host, then the agent channel, then the tenant plane', async () =>
    {
        const R = RecordingListeners
        assert.deepEqual(await R.StartedBy(ControlPlaneRole.All), [R.Operator, R.Channel, R.Tenant])
    })

    it('edge starts only the agent channel', async () =>
    {
        assert.deepEqual(await RecordingListeners.StartedBy(ControlPlaneRole.Edge), [RecordingListeners.Channel])
    })

    it('admin starts everything except the agent channel', async () =>
    {
        const R = RecordingListeners
        assert.deepEqual(await R.StartedBy(ControlPlaneRole.Admin), [R.Operator, R.Tenant])
    })

    it('only roles that start the agent channel compose its host (and the console advert receiver behind it)', () =>
    {
        for (const role of ControlPlaneRoles.Known)
        {
            assert.equal(ControlPlaneRoles.ServesAgentChannel(role), ControlPlaneRoles.ListenersOf(role).AgentChannel, role)
        }
        assert.equal(ControlPlaneRoles.ServesAgentChannel(ControlPlaneRole.Admin), false)
        assert.equal(ChannelParts.ChannelOf(ControlPlaneRole.Admin), undefined)
        for (const role of [ControlPlaneRole.All, ControlPlaneRole.Edge])
        {
            assert.ok(ChannelParts.ChannelOf(role) instanceof AgentChannelHost, role)
        }
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
