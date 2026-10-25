import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ControlPlaneServer } from '../server.js'

describe('ControlPlaneServer.ParseAgentChannelPort', () =>
{
    const ValidPortRaw = '8443'
    const ValidPort = 8443
    const MaxPortRaw = '65535'
    const MaxPort = 65535
    const DefaultBind = '0.0.0.0'
    const LoopbackBind = '127.0.0.1'

    it('accepts a valid port', () =>
    {
        assert.equal(ControlPlaneServer.ParseAgentChannelPort(ValidPortRaw), ValidPort)
        assert.equal(ControlPlaneServer.ParseAgentChannelPort(MaxPortRaw), MaxPort)
    })

    for (const raw of [undefined, '', '0', '-1', '65536', 'abc', '1.5'])
    {
        it(`maps ${JSON.stringify(raw)} to the disabled sentinel`, () =>
        {
            assert.equal(ControlPlaneServer.ParseAgentChannelPort(raw), ControlPlaneServer.AgentChannelDisabled)
        })
    }

    it('defaults the bind to all interfaces and honours an override', () =>
    {
        assert.equal(ControlPlaneServer.ParseAgentChannelBind(undefined), DefaultBind)
        assert.equal(ControlPlaneServer.ParseAgentChannelBind(''), DefaultBind)
        assert.equal(ControlPlaneServer.ParseAgentChannelBind(LoopbackBind), LoopbackBind)
    })
})
