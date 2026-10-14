import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sep } from 'node:path'
import { InMemoryTenantCoordinator } from '../tenant-coordinator.js'
import { InMemoryTenantProvisioning, TenantRegistry } from '../tenant-registry.js'
import { TenantPurpose } from '../tenant-purpose.js'
import { PragmaticServer } from '../../pragmatic-server.js'

class PurposeFixture
{
    public static readonly KeyEnv = 'PS_C1_KEY'
    public static readonly BaseDir = 'base'
    public static readonly TenantId = 't1'
    public static readonly Display = 'T'

    public static Registry(): TenantRegistry
    {
        return new TenantRegistry(PurposeFixture.BaseDir, { base64Env: PurposeFixture.KeyEnv }, new InMemoryTenantProvisioning(new Map()), new InMemoryTenantCoordinator())
    }
}

test('OptionsFor threads Runtime purpose and the per-tenant applications root', () =>
{
    const options = PurposeFixture.Registry().OptionsFor(PurposeFixture.TenantId, { displayName: PurposeFixture.Display, purpose: TenantPurpose.Runtime })
    assert.equal(options.purpose, TenantPurpose.Runtime)
    assert.ok(options.applicationsRoot!.endsWith(`${PurposeFixture.TenantId}${sep}applications`))
})

test('absent purpose defaults to Development', () =>
{
    const options = PurposeFixture.Registry().OptionsFor(PurposeFixture.TenantId, { displayName: PurposeFixture.Display })
    assert.equal(new PragmaticServer(options).Purpose(), TenantPurpose.Development)
})

test('a bare PragmaticServer is Development', () =>
{
    assert.equal(new PragmaticServer({}).Purpose(), TenantPurpose.Development)
})
