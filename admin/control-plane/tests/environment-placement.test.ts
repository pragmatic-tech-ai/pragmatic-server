import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import { EnvStatus, EnvType, Template } from '../environment-record.js'
import type { EnvironmentRecord } from '../environment-record.js'
import { PlatformDirectory, HivePlacementError } from '../platform-directory.js'
import { EnvironmentPlacement, EnvironmentNotPlacedError } from '../environment-placement.js'

class PlacementFixture
{
    public static readonly Prefix = 'envplace-'
    public static readonly Now = '2026-10-22T12:00:00.000Z'

    public dir = ''
    public directory!: PlatformDirectory
    public placement!: EnvironmentPlacement

    public static async Create(): Promise<PlacementFixture>
    {
        const f = new PlacementFixture()
        f.dir = await mkdtemp(join(tmpdir(), PlacementFixture.Prefix))
        f.directory = new PlatformDirectory(
            new ClientRegistry(join(f.dir, 'clients.json')),
            new TenantRegistry(join(f.dir, 'tenants.json')),
            new HiveRegistry(join(f.dir, 'hives.json')),
            { List: () => [] },
            () => new Date(PlacementFixture.Now))
        await f.directory.Load()
        await f.directory.CreateClient({ id: 'c1', displayName: 'C1' })
        await f.directory.CreateTenant({ id: 't1', clientId: 'c1', displayName: 'T1' })
        await f.directory.CreateTenant({ id: 't2', clientId: 'c1', displayName: 'T2' })
        await f.directory.CreateHive({
            id: 'h1', tenantId: 't1', displayName: 'H1',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: 'kube-ref' },
            registry: { mode: InfraMode.Attach, endpoint: 'reg.local', credentialRef: 'cred-ref' }
        })
        f.placement = new EnvironmentPlacement(f.directory)
        return f
    }

    public static Env(tenantId: string, hiveId?: string): EnvironmentRecord
    {
        return {
            name: 'e1', type: EnvType.Runtime, template: Template.RuntimePostgres, tenantId,
            hostPort: 1, containerName: 'c', volumeName: 'v', bundleDir: 'b', createdAt: PlacementFixture.Now,
            status: EnvStatus.Running, hiveId
        }
    }

    public async Dispose(): Promise<void>
    {
        await rm(this.dir, { recursive: true, force: true })
    }
}

test('WorkloadFor returns a workload carrying the hive id when the hive belongs to the tenant', async () =>
{
    const f = await PlacementFixture.Create()
    try
    {
        const workload = f.placement.WorkloadFor(PlacementFixture.Env('t1', 'h1'))
        assert.equal(workload.hiveId, 'h1')
        assert.equal(workload.environmentName, 'e1')
    }
    finally
    {
        await f.Dispose()
    }
})

test('WorkloadFor throws HivePlacementError when the hive belongs to a different tenant', async () =>
{
    const f = await PlacementFixture.Create()
    try
    {
        assert.throws(() => f.placement.WorkloadFor(PlacementFixture.Env('t2', 'h1')), HivePlacementError)
    }
    finally
    {
        await f.Dispose()
    }
})

test('WorkloadFor throws EnvironmentNotPlacedError when the record has no hive id', async () =>
{
    const f = await PlacementFixture.Create()
    try
    {
        assert.throws(() => f.placement.WorkloadFor(PlacementFixture.Env('t1')), EnvironmentNotPlacedError)
    }
    finally
    {
        await f.Dispose()
    }
})
