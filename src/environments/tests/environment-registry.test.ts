import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryEnvironmentCoordinator } from '../environment-coordinator.js'
import { InMemoryEnvironmentProvisioning, EnvironmentRegistry } from '../environment-registry.js'
import type { EnvironmentProvisioning } from '../environment-provisioning.js'
import type { IdentityStoreSet } from '@pragmatic-tech-ai/pragmatic-identity'
import { NodePlatform } from '../../platform/node-platform.js'
import { DeploymentMode } from '@pragmatic-tech-ai/pragmatic-env-cluster'

class RecordingPlatform extends NodePlatform
{
    public static readonly IdentityStoresCall = 'identityStores'

    public readonly calls: string[] = []

    public override CreateIdentityStores(identityRoot: string, masterKey: Buffer): Promise<IdentityStoreSet>
    {
        this.calls.push(RecordingPlatform.IdentityStoresCall)
        return super.CreateIdentityStores(identityRoot, masterKey)
    }
}

class RegistryFixture
{
    public static readonly KeyEnv = 'PS_5A_KEY'

    public static Dirs(): { baseDir: string; fixture: string }
    {
        const baseDir = mkdtempSync(join(tmpdir(), 'ps-5a-base-'))
        const fixture = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution')
        return { baseDir, fixture }
    }

    public static SeedSolution(baseDir: string, environmentId: string, fixture: string): string
    {
        const solution = join(baseDir, environmentId, 'solution')
        mkdirSync(join(baseDir, environmentId), { recursive: true })
        cpSync(fixture, solution, { recursive: true })
        return solution
    }

    public static Provisioning(...environmentIds: string[]): InMemoryEnvironmentProvisioning
    {
        const entries = new Map<string, EnvironmentProvisioning>()
        for (const id of environmentIds)
        {
            entries.set(id, { displayName: id.toUpperCase() })
        }
        return new InMemoryEnvironmentProvisioning(entries)
    }

    public static Registry(baseDir: string, provisioning: InMemoryEnvironmentProvisioning): EnvironmentRegistry
    {
        process.env[RegistryFixture.KeyEnv] = randomBytes(32).toString('base64')
        return new EnvironmentRegistry(baseDir, { base64Env: RegistryFixture.KeyEnv }, provisioning, new InMemoryEnvironmentCoordinator())
    }
}

test('two environments get isolated servers that each see only their own solution', async () =>
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
        assert.equal(server1.Realm().Id, 't1')
        assert.equal(server2.Realm().Id, 't2')
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

test('an unprovisioned environment is rejected with no server created', async () =>
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

test('idle-evict disposes a zero-connection environment; a connected one survives; re-request cold-rebuilds', async () =>
{
    const { baseDir } = RegistryFixture.Dirs()
    const registry = RegistryFixture.Registry(baseDir, RegistryFixture.Provisioning('t1', 't2'))
    try
    {
        const first = await registry.ServerFor('t1')
        const t2 = await registry.ServerFor('t2')
        registry.Acquire('t2') // t2 has a live connection
        await registry.EvictIdle(Number.MAX_SAFE_INTEGER, 0)
        assert.notEqual(await registry.ServerFor('t1'), first) // t1 was evicted -> cold rebuild = new instance
        assert.equal(await registry.ServerFor('t2'), t2) // connected environment survived
        registry.Release('t2')
    }
    finally
    {
        await registry.DisposeAll()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[RegistryFixture.KeyEnv]
    }
})

test('concurrent cold builds of the same environment dedupe to one server', async () =>
{
    const { baseDir } = RegistryFixture.Dirs()
    const registry = RegistryFixture.Registry(baseDir, RegistryFixture.Provisioning('t1'))
    try
    {
        const [a, b] = await Promise.all([registry.ServerFor('t1'), registry.ServerFor('t1')])
        assert.equal(a, b)
    }
    finally
    {
        await registry.DisposeAll()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[RegistryFixture.KeyEnv]
    }
})

test('EnvironmentRegistry threads the injected platform to each environment server', async () =>
{
    const { baseDir } = RegistryFixture.Dirs()
    process.env[RegistryFixture.KeyEnv] = randomBytes(32).toString('base64')
    const recording = new RecordingPlatform()
    const registry = new EnvironmentRegistry(baseDir, { base64Env: RegistryFixture.KeyEnv }, RegistryFixture.Provisioning('t1'), new InMemoryEnvironmentCoordinator(), recording, DeploymentMode.Cloud)
    try
    {
        await registry.ServerFor('t1')
        assert.ok(recording.calls.includes(RecordingPlatform.IdentityStoresCall))
    }
    finally
    {
        await registry.DisposeAll()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[RegistryFixture.KeyEnv]
    }
})

test('EnvironmentRegistry threads deploymentMode: Cloud with no platform fails closed', async () =>
{
    const { baseDir } = RegistryFixture.Dirs()
    process.env[RegistryFixture.KeyEnv] = randomBytes(32).toString('base64')
    const registry = new EnvironmentRegistry(baseDir, { base64Env: RegistryFixture.KeyEnv }, RegistryFixture.Provisioning('t1'), new InMemoryEnvironmentCoordinator(), undefined, DeploymentMode.Cloud)
    try
    {
        await assert.rejects(() => registry.ServerFor('t1'), /explicit platform bundle/)
    }
    finally
    {
        await registry.DisposeAll()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[RegistryFixture.KeyEnv]
    }
})
