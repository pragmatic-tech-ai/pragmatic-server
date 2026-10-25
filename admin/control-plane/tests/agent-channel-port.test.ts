import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ControlPlaneServer } from '../server.js'

describe('ControlPlaneServer.ParseAgentChannelPort', () =>
{
    it('accepts a valid port', () =>
    {
        assert.equal(ControlPlaneServer.ParseAgentChannelPort('8443'), 8443)
        assert.equal(ControlPlaneServer.ParseAgentChannelPort('65535'), 65535)
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
        assert.equal(ControlPlaneServer.ParseAgentChannelBind(undefined), '0.0.0.0')
        assert.equal(ControlPlaneServer.ParseAgentChannelBind(''), '0.0.0.0')
        assert.equal(ControlPlaneServer.ParseAgentChannelBind('127.0.0.1'), '127.0.0.1')
    })
})
