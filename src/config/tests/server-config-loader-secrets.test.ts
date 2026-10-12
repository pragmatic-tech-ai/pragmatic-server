import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerConfigLoader } from '../server-config-loader.js'

class Env
{
    public static Base(): Record<string, string | undefined>
    {
        return { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_B64_ENV: 'PRAGMATIC_MASTER_KEY', PRAGMATIC_TENANT_ID: 'acme' }
    }

    public static NoFile(_path: string): string
    {
        throw new Error('no config file expected')
    }
}

test('no provisioned-secrets file leaves provisionedSecretsFile undefined', () =>
{
    const config = ServerConfigLoader.Load(Env.Base(), Env.NoFile)
    assert.equal(config.provisionedSecretsFile, undefined)
})

test('PRAGMATIC_PROVISIONED_SECRETS_FILE is carried into the config', () =>
{
    const env = { ...Env.Base(), PRAGMATIC_PROVISIONED_SECRETS_FILE: '/run/secrets/provisioned/secrets.json' }
    const config = ServerConfigLoader.Load(env, Env.NoFile)
    assert.equal(config.provisionedSecretsFile, '/run/secrets/provisioned/secrets.json')
})
