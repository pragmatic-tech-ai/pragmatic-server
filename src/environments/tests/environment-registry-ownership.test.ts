import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EnvironmentRegistry, InMemoryEnvironmentProvisioning } from '../environment-registry.js'
import { EnvironmentOwnedElsewhereError, type IEnvironmentOwnership, type EnvironmentLostHandler } from '../environment-ownership.js'
import { InMemoryEnvironmentCoordinator } from '../environment-coordinator.js'
import { DeploymentMode } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import type { EnvironmentProvisioning } from '../environment-provisioning.js'
import type { IWriteLock } from '../../host/cypher/write-lock.js'

class FakeOwnership implements IEnvironmentOwnership
{
    public granted = true
    public healthy = true
    public acquired: string[] = []
    public released: string[] = []
    public lost: EnvironmentLostHandler = () => {}

    public async Start(): Promise<void>
    {
    }

    public async Acquire(environmentId: string): Promise<boolean>
    {
        this.acquired.push(environmentId)
        return this.granted
    }

    public async Release(environmentId: string): Promise<void>
    {
        this.released.push(environmentId)
    }

    public async ReleaseAll(): Promise<void>
    {
    }

    public Healthy(): boolean
    {
        return this.healthy
    }

    public OnLost(handler: EnvironmentLostHandler): void
    {
        this.lost = handler
    }
}

class Fixtures
{
    public static RegistryWith(ownership: IEnvironmentOwnership): EnvironmentRegistry
    {
        const entries = new Map<string, EnvironmentProvisioning>([['acme', { displayName: 'Acme' }]])
        const provisioning = new InMemoryEnvironmentProvisioning(entries)
        return new EnvironmentRegistry('C:/tmp/does-not-matter', { base64Env: 'PRAGMATIC_MASTER_KEY' }, provisioning, new InMemoryEnvironmentCoordinator(), undefined, DeploymentMode.Local, ownership)
    }
}

test('ServerFor throws EnvironmentOwnedElsewhereError when ownership denies', async () =>
{
    const ownership = new FakeOwnership()
    ownership.granted = false
    const registry = Fixtures.RegistryWith(ownership)
    await assert.rejects(() => registry.ServerFor('acme'), EnvironmentOwnedElsewhereError)
})

test('ServerFor rejects an unprovisioned environment before acquiring ownership', async () =>
{
    const ownership = new FakeOwnership()
    const registry = Fixtures.RegistryWith(ownership)
    await assert.rejects(() => registry.ServerFor('ghost'))
    assert.deepEqual(ownership.released, [])
    assert.deepEqual(ownership.acquired, [])
})

test('OwnershipHealthy delegates to the ownership', () =>
{
    const ownership = new FakeOwnership()
    ownership.healthy = false
    const registry = Fixtures.RegistryWith(ownership)
    assert.equal(registry.OwnershipHealthy(), false)
})

test('an environment server is built with the ownership write lock for that environment (none without one)', () =>
{
    const lock: IWriteLock = { Acquire: () => Promise.reject(new Error('unused')) }
    const scoped: string[] = []
    const clustered = new FakeOwnership() as FakeOwnership & { WriteLock(environmentId: string): IWriteLock }
    clustered.WriteLock = environmentId => { scoped.push(environmentId); return lock }
    assert.equal(Fixtures.RegistryWith(clustered).OptionsFor('acme', { displayName: 'Acme' }).writeLock, lock)
    assert.deepEqual(scoped, ['acme'])
    assert.equal(Fixtures.RegistryWith(new FakeOwnership()).OptionsFor('acme', { displayName: 'Acme' }).writeLock, undefined)
})
