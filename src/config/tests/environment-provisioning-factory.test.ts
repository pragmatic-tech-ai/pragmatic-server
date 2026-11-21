import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode, type ServerConfig } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { EnvironmentProvisioningFactory } from '../environment-provisioning-factory.js'

class Configs
{
    public static Single(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/data', masterKey: { keyFilePath: '/k' }, deploymentMode: DeploymentMode.Local, singleEnvironment: { id: 't1', displayName: 'Environment One' } }
    }

    public static File(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/data', masterKey: { keyFilePath: '/k' }, deploymentMode: DeploymentMode.Local, environmentsFile: '/cfg/environments.json' }
    }
}

test('builds a single-environment provisioning from env config', () =>
{
    const result = EnvironmentProvisioningFactory.Build(Configs.Single(), () => { throw new Error('no read') })
    assert.equal(result.provisioning.OptionsFor('t1')?.displayName, 'Environment One')
    assert.equal(result.provisioning.OptionsFor('other'), null)
    assert.equal(result.environmentCount, 1)
})

test('builds a file provisioning when an environments file is configured', () =>
{
    const read = (path: string): string =>
    {
        if (path === '/cfg/environments.json')
        {
            return JSON.stringify({ environments: { acme: { displayName: 'Acme' } } })
        }
        throw new Error('unexpected read')
    }
    const result = EnvironmentProvisioningFactory.Build(Configs.File(), read)
    assert.equal(result.provisioning.OptionsFor('acme')?.displayName, 'Acme')
    assert.equal(result.environmentCount, 1)
})
