import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TenantRegistry, InMemoryTenantProvisioning } from '../tenant-registry.js'
import { TenantOwnedElsewhereError } from '../tenant-ownership.js'
import type { ITenantOwnership, TenantLostHandler } from '../tenant-ownership.js'
import { InMemoryTenantCoordinator } from '../tenant-coordinator.js'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import type { TenantProvisioning } from '../tenant-provisioning.js'

class FakeOwnership implements ITenantOwnership
{
    public granted = true
    public healthy = true
    public acquired: string[] = []
    public released: string[] = []
    public lost: TenantLostHandler = () => {}

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

    public OnLost(handler: TenantLostHandler): void
    {
        this.lost = handler
    }
}

class Fixtures
{
    public static RegistryWith(ownership: ITenantOwnership): TenantRegistry
    {
        const entries = new Map<string, TenantProvisioning>([['acme', { displayName: 'Acme' }]])
        const provisioning = new InMemoryTenantProvisioning(entries)
        return new TenantRegistry('C:/tmp/does-not-matter', { base64Env: 'PRAGMATIC_MASTER_KEY' }, provisioning, new InMemoryTenantCoordinator(), undefined, DeploymentMode.Local, ownership)
    }
}

test('ServerFor throws TenantOwnedElsewhereError when ownership denies', async () =>
{
    const ownership = new FakeOwnership()
    ownership.granted = false
    const registry = Fixtures.RegistryWith(ownership)
    await assert.rejects(() => registry.ServerFor('acme'), TenantOwnedElsewhereError)
})

test('ServerFor rejects an unprovisioned tenant before acquiring ownership', async () =>
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
