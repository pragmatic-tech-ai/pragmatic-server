import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleBuilder, EnvKind, TenantPurposeName } from '../bundle.js'

test('demo bundle generates key, tenants.json, tenant-config.json, package, and application.json', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    await BundleBuilder.Generate({ name: 'demo', kind: EnvKind.Demo, tenantId: 'contoso', purpose: TenantPurposeName.Runtime, hostPort: 8081 }, dir)
    assert.ok(existsSync(join(dir, 'master.key')))
    assert.ok(existsSync(join(dir, 'provisioned-secrets.json')))
    const tenants = JSON.parse(readFileSync(join(dir, 'tenants.json'), 'utf8'))
    assert.ok(tenants.tenants.contoso)
    assert.equal(tenants.tenants.contoso.purpose, 1)
    assert.ok(existsSync(join(dir, 'data', 'contoso', 'identity', 'tenant-config.json')))
    assert.ok(existsSync(join(dir, 'data', 'contoso', 'packages', 'northwind', '1.0.0', 'model.json')))
    assert.ok(existsSync(join(dir, 'data', 'contoso', 'applications', 'northwind', 'application.json')))
})

test('explicit seedDir overrides the name-derived seed path', async () =>
{
    const root = mkdtempSync(join(tmpdir(), 'bundle-explicit-'))
    try
    {
        const seedDir = join(root, 'seed')
        const bundleDir = join(root, 'bundle')
        mkdirSync(seedDir, { recursive: true })
        const model = { businessUnits: [{ id: 'acme', name: 'Acme' }], teams: [], membership: { claimsMapping: [], overrides: [] }, ownershipRules: [] }
        writeFileSync(join(seedDir, 'security-model.json'), JSON.stringify(model))
        writeFileSync(join(seedDir, 'users.json'), JSON.stringify([{ principalId: 'u1', email: 'u1@x.test', passwordRef: 'u1-pw', coarseRole: 'Editor' }]))
        await BundleBuilder.Generate({ name: 'custom-name', kind: EnvKind.Demo, tenantId: 'acme', purpose: TenantPurposeName.Runtime, hostPort: 8082 }, bundleDir, seedDir)
        const config = JSON.parse(readFileSync(join(bundleDir, 'data', 'acme', 'identity', 'tenant-config.json'), 'utf8'))
        assert.deepEqual(config.configs.acme.securityModel, model)
        const secrets = JSON.parse(readFileSync(join(bundleDir, 'provisioned-secrets.json'), 'utf8'))
        assert.ok('u1-pw' in secrets)
    }
    finally
    {
        rmSync(root, { recursive: true, force: true })
    }
})

test('omitted seedDir keeps the name-derived seed path', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    await BundleBuilder.Generate({ name: 'demo', kind: EnvKind.Demo, tenantId: 'contoso', purpose: TenantPurposeName.Runtime, hostPort: 8081 }, dir)
    const config = JSON.parse(readFileSync(join(dir, 'data', 'contoso', 'identity', 'tenant-config.json'), 'utf8'))
    assert.ok(config.configs.contoso.securityModel.businessUnits.length > 0)
    const secrets = JSON.parse(readFileSync(join(dir, 'provisioned-secrets.json'), 'utf8'))
    assert.ok('contoso-admin-pw' in secrets)
    for (const ref of ['rep-boston-pw', 'rep-atlanta-pw', 'manager-north-pw', 'finance-pw'])
    {
        assert.ok(ref in secrets)
    }
})

test('generate is idempotent: a second run keeps the same master key', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    const def = { name: 'dev', kind: EnvKind.Dev, tenantId: 'dev', purpose: TenantPurposeName.Development, hostPort: 8080 }
    await BundleBuilder.Generate(def, dir)
    const key1 = readFileSync(join(dir, 'master.key'))
    await BundleBuilder.Generate(def, dir)
    assert.deepEqual(readFileSync(join(dir, 'master.key')), key1)
})
