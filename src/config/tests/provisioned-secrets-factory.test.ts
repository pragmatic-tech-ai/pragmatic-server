import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerConfig } from '../server-config.js'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { ProvisionedSecretsFactory } from '../provisioned-secrets-factory.js'

class Configs
{
    public static Base(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/data', masterKey: { base64Env: 'K' }, deploymentMode: DeploymentMode.Local }
    }
}

test('Build returns undefined when no provisioned-secrets file is configured', () =>
{
    const source = ProvisionedSecretsFactory.Build(Configs.Base(), () => { throw new Error('should not read') })
    assert.equal(source, undefined)
})

test('Build reads the file and returns a source that resolves refs', () =>
{
    const config: ServerConfig = { ...Configs.Base(), provisionedSecretsFile: '/x/secrets.json' }
    const source = ProvisionedSecretsFactory.Build(config, path =>
    {
        assert.equal(path, '/x/secrets.json')
        return '{"acme/oidc/client-secret":"s3cr3t"}'
    })
    assert.ok(source !== undefined)
    assert.equal(source.Lookup('acme/oidc/client-secret'), 's3cr3t')
})
