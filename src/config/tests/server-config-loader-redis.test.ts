import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerConfigLoader } from '../server-config-loader.js'

class Env
{
    public static Base(): Record<string, string | undefined>
    {
        return { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_B64_ENV: 'PRAGMATIC_MASTER_KEY', PRAGMATIC_ENVIRONMENT_ID: 'acme' }
    }

    public static NoFile(_path: string): string
    {
        throw new Error('no config file expected')
    }
}

test('no Redis URL leaves redisUrl and replicaId undefined', () =>
{
    const config = ServerConfigLoader.Load(Env.Base(), Env.NoFile)
    assert.equal(config.redisUrl, undefined)
    assert.equal(config.replicaId, undefined)
})

test('a Redis URL is carried through and a replica id is resolved from HOSTNAME', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_REDIS_URL: 'redis://user:secret@host:6379', HOSTNAME: 'pod-7' }
    const config = ServerConfigLoader.Load(env, Env.NoFile)
    assert.equal(config.redisUrl, 'redis://user:secret@host:6379')
    assert.equal(config.replicaId, 'pod-7')
})

test('an explicit replica id wins over the hostname', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_REDIS_URL: 'redis://host:6379', PRAGMATIC_REPLICA_ID: 'chosen', HOSTNAME: 'pod-7' }
    const config = ServerConfigLoader.Load(env, Env.NoFile)
    assert.equal(config.replicaId, 'chosen')
})
