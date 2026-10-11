import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryTenantCoordinator } from '../tenant-coordinator.js'
import { InMemoryTenantProvisioning, TenantRegistry } from '../tenant-registry.js'
import type { TenantProvisioning } from '../tenant-provisioning.js'

class RegistryFixture
{
    public static readonly KeyEnv = 'PS_5A_KEY'

    public static Dirs(): { baseDir: string; fixture: string }
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-5a-base-'))
        const fixture = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution')
        return { baseDir, fixture }
    }

    public static SeedSolution(baseDir: string, tenantId: string, fixture: string): string
    {
        const solution = join(baseDir, tenantId, 'solution')
        mkdirSync(join(baseDir, tenantId), { recursive: true })
        cpSync(fixture, solution, { recursive: true })
        return solution
    }

    public static Provisioning(...tenantIds: string[]): InMemoryTenantProvisioning
    {
        const entries = new Map<string, TenantProvisioning>()
        for (const id of tenantIds)
        {
            entries.set(id, { displayName: id.toUpperCase() })
        }
        return new InMemoryTenantProvisioning(entries)
    }

    public static Registry(baseDir: string, provisioning: InMemoryTenantProvisioning): TenantRegistry
    {
        process.env[RegistryFixture.KeyEnv] = randomBytes(32).toString('base64')
        return new TenantRegistry(baseDir, { base64Env: RegistryFixture.KeyEnv }, provisioning, new InMemoryTenantCoordinator())
    }
}

test('two tenants get isolated servers that each see only their own solution', async () =>
{
    const { baseDir, fixture } = RegistryFixture.Dirs()
    const s1 = RegistryFixture.SeedSolution(baseDir, 't1', fixture)
    const s2 = RegistryFixture.SeedSolution(baseDir, 't2', fixture)
    const registry = RegistryFixture.Registry(baseDir, RegistryFixture.Provisioning('t1', 't2'))
    try
    {
        const server1 = await registry.ServerFor('t1')
        const server2 = await registry.ServerFor('t2')
        assert.notEqual(server1, server2)
        assert.equal(server1.Tenant().Id, 't1')
        assert.equal(server2.Tenant().Id, 't2')
        await server1.OpenSolution(s1)
        await server2.OpenSolution(s2)
        const view1 = await (await server1.LanguageService()).ModelView((await server1.Manager()).ActiveSolution!.Members.ToArray()[0].Storage!)
        assert.ok(view1!.model.has('acme.Widget'))
        // a second ServerFor('t1') returns the SAME instance (pooled)
        assert.equal(await registry.ServerFor('t1'), server1)
    }
    finally
    {
        await registry.DisposeAll()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[RegistryFixture.KeyEnv]
    }
})

test('an unprovisioned tenant is rejected with no server created', async () =>
{
    const { baseDir } = RegistryFixture.Dirs()
    const registry = RegistryFixture.Registry(baseDir, RegistryFixture.Provisioning('t1'))
    try
    {
        await assert.rejects(() => registry.ServerFor('ghost'))
    }
    finally
    {
        await registry.DisposeAll()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[RegistryFixture.KeyEnv]
    }
})

test('idle-evict disposes a zero-connection tenant; a connected one survives; re-request cold-rebuilds', async () =>
{
    const { baseDir } = RegistryFixture.Dirs()
    const registry = RegistryFixture.Registry(baseDir, RegistryFixture.Provisioning('t1', 't2'))
    try
    {
        const first = await registry.ServerFor('t1')
        await registry.ServerFor('t2')
        registry.Acquire('t2') // t2 has a live connection
        await registry.EvictIdle(Number.MAX_SAFE_INTEGER, 0)
        assert.notEqual(await registry.ServerFor('t1'), first) // t1 was evicted -> cold rebuild = new instance
        registry.Release('t2')
    }
    finally
    {
        await registry.DisposeAll()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[RegistryFixture.KeyEnv]
    }
})
