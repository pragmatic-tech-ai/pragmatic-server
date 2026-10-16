import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
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

test('generate is idempotent: a second run keeps the same master key', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    const def = { name: 'dev', kind: EnvKind.Dev, tenantId: 'dev', purpose: TenantPurposeName.Development, hostPort: 8080 }
    await BundleBuilder.Generate(def, dir)
    const key1 = readFileSync(join(dir, 'master.key'))
    await BundleBuilder.Generate(def, dir)
    assert.deepEqual(readFileSync(join(dir, 'master.key')), key1)
})
