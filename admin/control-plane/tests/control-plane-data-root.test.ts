import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { ControlPlaneServer } from '../server.js'

describe('ControlPlaneServer.DataRootOf', () =>
{
    const Here = resolve('/repo/admin/control-plane')
    const Override = resolve('/stacks/e2e')
    const VarName = 'PRAGMATIC_ADMIN_DATA_ROOT'

    it('defaults to the data folder beside the server', () =>
    {
        assert.equal(ControlPlaneServer.DataRootOf({}, Here), join(Here, 'data'))
        assert.equal(ControlPlaneServer.DataRootOf({ [VarName]: '' }, Here), join(Here, 'data'))
    })

    it('follows PRAGMATIC_ADMIN_DATA_ROOT, resolved to an absolute path', () =>
    {
        assert.equal(ControlPlaneServer.DataRootOf({ [VarName]: Override }, Here), Override)
        assert.equal(ControlPlaneServer.DataRootOf({ [VarName]: 'rel/root' }, Here), resolve('rel/root'))
    })
})
