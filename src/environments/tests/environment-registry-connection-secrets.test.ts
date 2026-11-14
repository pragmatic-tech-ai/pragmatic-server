import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryEnvironmentCoordinator } from '../environment-coordinator.js'
import { EnvironmentRegistry, InMemoryEnvironmentProvisioning } from '../environment-registry.js'
import type { EnvironmentProvisioning } from '../environment-provisioning.js'
import { ProvisionedSecretSource } from '../../config/provisioned-secret-source.js'

test('connectorSecretRefs are provisioned into the environment store through the registry', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-reg-conn-'))
    const keyEnv = 'PS_REG_CONN_KEY'
    process.env[keyEnv] = randomBytes(32).toString('base64')
    const entries = new Map<string, EnvironmentProvisioning>()
    entries.set('t1', { displayName: 'Environment One', connectorSecretRefs: ['t1/crm/pw'] })
    const provisioning = new InMemoryEnvironmentProvisioning(entries)
    const source = ProvisionedSecretSource.FromText('{"t1/crm/pw":"conn-secret"}')
    const registry = new EnvironmentRegistry(baseDir, { base64Env: keyEnv }, provisioning, new InMemoryEnvironmentCoordinator(), undefined, undefined, undefined, source)
    try
    {
        const server = await registry.ServerFor('t1')
        const pack = await server.Pack()
        assert.equal(await pack.Secrets.Get('t1/crm/pw'), 'conn-secret')
    }
    finally
    {
        await registry.DisposeAll()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[keyEnv]
    }
})
