import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { TenantProvisioningFactory } from '../tenant-provisioning-factory.js'
import type { ServerConfig } from '../server-config.js'

class Configs
{
    public static Single(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/data', masterKey: { keyFilePath: '/k' }, deploymentMode: DeploymentMode.Local, singleTenant: { id: 't1', displayName: 'Tenant One' } }
    }

    public static File(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/data', masterKey: { keyFilePath: '/k' }, deploymentMode: DeploymentMode.Local, tenantsFile: '/cfg/tenants.json' }
    }
}

test('builds a single-tenant provisioning from env config', () =>
{
    const provisioning = TenantProvisioningFactory.Build(Configs.Single(), () => { throw new Error('no read') })
    assert.equal(provisioning.OptionsFor('t1')?.displayName, 'Tenant One')
    assert.equal(provisioning.OptionsFor('other'), null)
})

test('builds a file provisioning when a tenants file is configured', () =>
{
    const read = (path: string): string =>
    {
        if (path === '/cfg/tenants.json')
        {
            return JSON.stringify({ tenants: { acme: { displayName: 'Acme' } } })
        }
        throw new Error('unexpected read')
    }
    const provisioning = TenantProvisioningFactory.Build(Configs.File(), read)
    assert.equal(provisioning.OptionsFor('acme')?.displayName, 'Acme')
})
