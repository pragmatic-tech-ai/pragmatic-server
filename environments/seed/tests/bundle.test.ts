import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DelegationDepth } from '@pragmatic-tech-ai/todl-identity'
import { BundleBuilder, EnvKind, TenantPurposeName } from '../bundle.js'

test('demo bundle generates key, tenants.json, tenant-config.json, package, and application.json', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    await BundleBuilder.Generate({ name: 'demo', kind: EnvKind.Demo, environmentId: 'contoso', purpose: TenantPurposeName.Runtime, hostPort: 8081 }, dir)
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
        await BundleBuilder.Generate({ name: 'custom-name', kind: EnvKind.Demo, environmentId: 'acme', purpose: TenantPurposeName.Runtime, hostPort: 8082 }, bundleDir, seedDir)
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
    await BundleBuilder.Generate({ name: 'demo', kind: EnvKind.Demo, environmentId: 'contoso', purpose: TenantPurposeName.Runtime, hostPort: 8081 }, dir)
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
    const def = { name: 'dev', kind: EnvKind.Dev, environmentId: 'dev', purpose: TenantPurposeName.Development, hostPort: 8080 }
    await BundleBuilder.Generate(def, dir)
    const key1 = readFileSync(join(dir, 'master.key'))
    await BundleBuilder.Generate(def, dir)
    assert.deepEqual(readFileSync(join(dir, 'master.key')), key1)
})

test('a RuntimePostgres tenant bundle declares the sql connection and allows sql', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    const database = { connectionName: 'appdb', host: 'pragmatic-env-rt-db', port: 5432, database: 'appdb', user: 'appuser', password: 'pw-secret', hostPort: 55432 }
    await BundleBuilder.Generate({ name: 'rt', kind: EnvKind.Dev, environmentId: 'rt', purpose: TenantPurposeName.Runtime, hostPort: 8083, database }, dir)
    const tenant = JSON.parse(readFileSync(join(dir, 'tenants.json'), 'utf8')).tenants.rt
    assert.ok(Object.values(tenant.connections.appdb.settings).every(v => typeof v === 'string'))
    assert.equal(tenant.connections.appdb.settings.port, '5432')
    assert.deepEqual(tenant.connections.appdb.settings, { host: 'pragmatic-env-rt-db', port: '5432', database: 'appdb', user: 'appuser' })
    assert.equal(tenant.connections.appdb.secretRef, 'rt/appdb/password')
    assert.deepEqual(tenant.connectorsPolicy.adapterAllowlist, ['sql'])
    assert.equal(tenant.connectorsPolicy.catalogOnly, true)
    const secrets = JSON.parse(readFileSync(join(dir, 'provisioned-secrets.json'), 'utf8'))
    assert.equal(secrets['rt/appdb/password'], 'pw-secret')
    assert.ok(!JSON.stringify(tenant).includes('pw-secret'))
})

test('a tenant without a database keeps deny-all and no connections', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    await BundleBuilder.Generate({ name: 'dev', kind: EnvKind.Dev, environmentId: 'dev', purpose: TenantPurposeName.Development, hostPort: 8080 }, dir)
    const tenant = JSON.parse(readFileSync(join(dir, 'tenants.json'), 'utf8')).tenants.dev
    assert.deepEqual(tenant.connectorsPolicy.adapterAllowlist, [])
    assert.equal(tenant.connections, undefined)
})

test('a federated bundle emits generic-oidc providerSettings, AuthnDirectory depth, and the client secret', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    const oidc = { issuer: 'https://idp.test', discoveryUrl: 'https://idp.test/.well-known/openid-configuration', clientId: 'cid', redirectUri: 'https://app.test/cb', secretRef: 'contoso/oidc/client-secret', secret: 's3cret' }
    await BundleBuilder.Generate({ name: 'demo', kind: EnvKind.Demo, environmentId: 'contoso', purpose: TenantPurposeName.Runtime, hostPort: 8081 }, dir, undefined, oidc)
    const record = JSON.parse(readFileSync(join(dir, 'data', 'contoso', 'identity', 'tenant-config.json'), 'utf8')).configs.contoso
    assert.equal(record.packId, 'generic-oidc')
    assert.equal(record.delegationDepth, DelegationDepth.AuthnDirectory)
    assert.equal(record.delegationDepth, 0)
    assert.deepEqual(record.providerSettings, [
        ['issuer', 'https://idp.test'],
        ['discoveryUrl', 'https://idp.test/.well-known/openid-configuration'],
        ['clientId', 'cid'],
        ['redirectUri', 'https://app.test/cb'],
        ['secretRef', 'contoso/oidc/client-secret'],
    ])
    const secrets = JSON.parse(readFileSync(join(dir, 'provisioned-secrets.json'), 'utf8'))
    assert.equal(secrets['contoso/oidc/client-secret'], 's3cret')
})

test('a non-federated bundle keeps the local pack with empty providerSettings', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    await BundleBuilder.Generate({ name: 'dev', kind: EnvKind.Dev, environmentId: 'dev', purpose: TenantPurposeName.Development, hostPort: 8080 }, dir)
    const record = JSON.parse(readFileSync(join(dir, 'data', 'dev', 'identity', 'tenant-config.json'), 'utf8')).configs.dev
    assert.equal(record.packId, 'local')
    assert.equal(record.delegationDepth, DelegationDepth.FullAuthz)
    assert.deepEqual(record.providerSettings, [])
})

test('a federated re-generate merges the OIDC secret into an existing provisioned-secrets.json', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    const def = { name: 'dev', kind: EnvKind.Dev, environmentId: 'dev', purpose: TenantPurposeName.Development, hostPort: 8080 }
    await BundleBuilder.Generate(def, dir)
    const before = JSON.parse(readFileSync(join(dir, 'provisioned-secrets.json'), 'utf8'))
    const oidc = { issuer: 'https://idp.test', discoveryUrl: 'https://idp.test/d', clientId: 'cid', redirectUri: 'https://app.test/cb', secretRef: 'dev/oidc/client-secret', secret: 's3cret' }
    await BundleBuilder.Generate(def, dir, undefined, oidc)
    const after = JSON.parse(readFileSync(join(dir, 'provisioned-secrets.json'), 'utf8'))
    assert.equal(after['dev/oidc/client-secret'], 's3cret')
    assert.deepEqual({ ...after, 'dev/oidc/client-secret': undefined }, { ...before, 'dev/oidc/client-secret': undefined })
})
