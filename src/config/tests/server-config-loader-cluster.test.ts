import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerConfigLoader } from '../server-config-loader.js'

class Env
{
    public static Base(): Record<string, string | undefined>
    {
        return { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_B64_ENV: 'PRAGMATIC_MASTER_KEY', PRAGMATIC_ENVIRONMENT_ID: 'acme' }
    }

    public static NoFile(_p: string): string
    {
        throw new Error('no file')
    }

    public static Tls(): Record<string, string>
    {
        return { PRAGMATIC_TLS_CERT_FILE: '/c.pem', PRAGMATIC_TLS_KEY_FILE: '/k.pem', PRAGMATIC_TLS_CA_FILE: '/ca.pem' }
    }
}

test('the TLS triple is carried into config when all three are present', () =>
{
    const config = ServerConfigLoader.Load({ ...Env.Base(), ...Env.Tls() }, Env.NoFile)
    assert.deepEqual(config.tls, { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' })
})

test('a partial TLS triple fails closed naming the missing var (Review Focus 2)', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_TLS_CERT_FILE: '/c.pem', PRAGMATIC_TLS_KEY_FILE: '/k.pem' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoFile), /PRAGMATIC_TLS_CA_FILE/)
})

test('no TLS vars leaves tls undefined (single-image path unchanged)', () =>
{
    const config = ServerConfigLoader.Load(Env.Base(), Env.NoFile)
    assert.equal(config.tls, undefined)
})

test('advertise, server name and health port are parsed', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_WORKER_ADVERTISE_HOST: 'w.internal', PRAGMATIC_WORKER_ADVERTISE_PORT: '8443', PRAGMATIC_WORKER_SERVERNAME: 'pragmatic-worker', PRAGMATIC_HEALTH_PORT: '8081' }
    const config = ServerConfigLoader.Load(env, Env.NoFile)
    assert.equal(config.workerAdvertiseHost, 'w.internal')
    assert.equal(config.workerAdvertisePort, 8443)
    assert.equal(config.workerServerName, 'pragmatic-worker')
    assert.equal(config.healthPort, 8081)
})

test('LoadGateway requires only TLS + redis + port, not baseDir/masterKey/tenant', () =>
{
    const env = { ...Env.Tls(), PRAGMATIC_REDIS_URL: 'redis://r:6379', PRAGMATIC_PORT: '8080', PRAGMATIC_WORKER_SERVERNAME: 'pragmatic-worker' }
    const gw = ServerConfigLoader.LoadGateway(env)
    assert.deepEqual(gw.tls, { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' })
    assert.equal(gw.redisUrl, 'redis://r:6379')
    assert.equal(gw.port, 8080)
    assert.equal(gw.workerServerName, 'pragmatic-worker')
})

test('LoadGateway fails closed without TLS', () =>
{
    assert.throws(() => ServerConfigLoader.LoadGateway({ PRAGMATIC_REDIS_URL: 'redis://r:6379' }), /PRAGMATIC_TLS/)
})

test('LoadGateway fails closed without redis', () =>
{
    assert.throws(() => ServerConfigLoader.LoadGateway({ ...Env.Tls() }), /PRAGMATIC_REDIS_URL/)
})

test('a missing cert (key+ca present) fails closed naming the cert var', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_TLS_KEY_FILE: '/k.pem', PRAGMATIC_TLS_CA_FILE: '/ca.pem' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoFile), /PRAGMATIC_TLS_CERT_FILE/)
})

test('a missing key (cert+ca present) fails closed naming the key var', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_TLS_CERT_FILE: '/c.pem', PRAGMATIC_TLS_CA_FILE: '/ca.pem' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoFile), /PRAGMATIC_TLS_KEY_FILE/)
})

test('an empty-string TLS var is treated as absent (fails closed)', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_TLS_CERT_FILE: '', PRAGMATIC_TLS_KEY_FILE: '/k.pem', PRAGMATIC_TLS_CA_FILE: '/ca.pem' }
    assert.throws(() => ServerConfigLoader.Load(env, Env.NoFile), /PRAGMATIC_TLS_CERT_FILE/)
})
