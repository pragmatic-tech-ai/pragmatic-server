import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ControlPlaneServer } from '../server.js'

describe('ControlPlaneServer.ReadOperatorOptions', () =>
{
    it('uses defaults when env is empty', () =>
    {
        const o = ControlPlaneServer.ReadOperatorOptions({}, '/data')
        assert.equal(o.operatorEmail, 'admin@control-plane.test')
        assert.equal(o.masterKeyFile, join('/data', 'master.key'))
        assert.equal(o.identityRoot, join('/data', 'identity'))
        assert.equal(o.secureCookie, false)
        assert.equal(o.initialPassword, undefined)
    })

    it('honors all env vars', () =>
    {
        const o = ControlPlaneServer.ReadOperatorOptions({
            PRAGMATIC_ADMIN_MASTER_KEY_FILE: '/k/mk',
            PRAGMATIC_ADMIN_OPERATOR_EMAIL: 'op@x.test',
            PRAGMATIC_ADMIN_OPERATOR_PASSWORD: 'pw',
            PRAGMATIC_ADMIN_SECURE_COOKIE: 'true',
        }, '/data')
        assert.equal(o.masterKeyFile, '/k/mk')
        assert.equal(o.operatorEmail, 'op@x.test')
        assert.equal(o.initialPassword, 'pw')
        assert.equal(o.secureCookie, true)
    })

    it('treats an empty password as undefined', () =>
    {
        const o = ControlPlaneServer.ReadOperatorOptions({ PRAGMATIC_ADMIN_OPERATOR_PASSWORD: '' }, '/data')
        assert.equal(o.initialPassword, undefined)
    })

    it('accepts 1 for secureCookie and rejects other values', () =>
    {
        assert.equal(ControlPlaneServer.ReadOperatorOptions({ PRAGMATIC_ADMIN_SECURE_COOKIE: '1' }, '/data').secureCookie, true)
        assert.equal(ControlPlaneServer.ReadOperatorOptions({ PRAGMATIC_ADMIN_SECURE_COOKIE: 'yes' }, '/data').secureCookie, false)
    })
})
