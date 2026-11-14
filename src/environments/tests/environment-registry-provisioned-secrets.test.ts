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

test('the provisioned source threads through the registry and writes both named refs into the environment store', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-reg-sec-'))
    const keyEnv = 'PS_REG_SEC_KEY'
    process.env[keyEnv] = randomBytes(32).toString('base64')
    const entries = new Map<string, EnvironmentProvisioning>()
    entries.set('t1', {
        displayName: 'Environment One',
        bootstrap: { adminEmail: 'admin@x.io', adminPrincipalId: 'admin', adminPasswordRef: 't1/bootstrap/admin', ownerGrant: true },
        oidc: { issuer: 'https://issuer.test', clientId: 'cid', clientSecretRef: 't1/oidc/client-secret', discoveryUrl: 'https://issuer.test/.well-known/openid-configuration', redirectUri: 'https://app.test/cb', provider: 'generic' },
    })
    const provisioning = new InMemoryEnvironmentProvisioning(entries)
    const source = ProvisionedSecretSource.FromText('{"t1/bootstrap/admin":"admin-pw-12345","t1/oidc/client-secret":"oidc-secret-xyz"}')
    const registry = new EnvironmentRegistry(baseDir, { base64Env: keyEnv }, provisioning, new InMemoryEnvironmentCoordinator(), undefined, undefined, undefined, source)
    try
    {
        const server = await registry.ServerFor('t1')
        const pack = await server.Pack()
        assert.equal(await pack.Secrets.Get('t1/oidc/client-secret'), 'oidc-secret-xyz')
        assert.equal(await pack.Secrets.Get('t1/bootstrap/admin'), 'admin-pw-12345')
    }
    finally
    {
        await registry.DisposeAll()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[keyEnv]
    }
})
