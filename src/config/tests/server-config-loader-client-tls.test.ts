import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerConfigLoader } from '../server-config-loader.js'

class Env
{
    public static Base(): Record<string, string | undefined>
    {
        return { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_B64_ENV: 'PRAGMATIC_MASTER_KEY', PRAGMATIC_TENANT_ID: 'acme' }
    }

    public static NoFile(_p: string): string
    {
        throw new Error('no file')
    }
}

test('client TLS absent -> clientTls undefined', () =>
{
    const config = ServerConfigLoader.Load(Env.Base(), Env.NoFile)
    assert.equal(config.clientTls, undefined)
})

test('client TLS complete -> clientTls populated', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_CLIENT_TLS_CERT_FILE: '/c', PRAGMATIC_CLIENT_TLS_KEY_FILE: '/k', PRAGMATIC_CLIENT_TLS_CA_FILE: '/ca' }
    const config = ServerConfigLoader.Load(env, Env.NoFile)
    assert.deepEqual(config.clientTls, { certFile: '/c', keyFile: '/k', caFile: '/ca' })
})

test('client TLS partial (cert without key) fails closed naming the missing piece', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_CLIENT_TLS_CERT_FILE: '/c', PRAGMATIC_CLIENT_TLS_CA_FILE: '/ca' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoFile), /client TLS key/)
})
