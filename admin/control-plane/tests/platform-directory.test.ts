import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { ClusterSpec, RegistrySpec } from '../platform-records.js'
import { EnvStatus, EnvType, Template } from '../environment-record.js'
import type { EnvironmentRecord } from '../environment-record.js'
import {
    PlatformDirectory,
    RecordExistsError,
    UnknownClientError,
    UnknownTenantError,
    ClientHasTenantsError,
    TenantHasHivesError,
    HiveHasEnvironmentsError,
    HivePlacementError
} from '../platform-directory.js'
import type { IEnvironmentLookup } from '../platform-directory.js'

class FakeEnvironments implements IEnvironmentLookup
{
    public constructor(private readonly records: readonly EnvironmentRecord[])
    {
    }

    public List(): readonly EnvironmentRecord[]
    {
        return this.records
    }
}

class DirectoryFixture
{
    public static readonly Prefix = 'platdir-'
    public static readonly Encoding = 'utf8'
    public static readonly Now = '2026-10-22T12:00:00.000Z'
    public static readonly ConfigRef = 'kube-config-ref'
    public static readonly CredentialRef = 'registry-cred-ref'
    public static readonly SecretValue = 'super-secret-value'

    public dir = ''
    public hivesPath = ''
    public directory!: PlatformDirectory

    public static async Create(envs: readonly EnvironmentRecord[] = []): Promise<DirectoryFixture>
    {
        const f = new DirectoryFixture()
        f.dir = await mkdtemp(join(tmpdir(), DirectoryFixture.Prefix))
        f.hivesPath = join(f.dir, 'hives.json')
        f.directory = new PlatformDirectory(
            new ClientRegistry(join(f.dir, 'clients.json')),
            new TenantRegistry(join(f.dir, 'tenants.json')),
            new HiveRegistry(f.hivesPath),
            new FakeEnvironments(envs),
            () => new Date(DirectoryFixture.Now))
        await f.directory.Load()
        return f
    }

    public static Cluster(): ClusterSpec
    {
        return { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: DirectoryFixture.ConfigRef }
    }

    public static Registry(): RegistrySpec
    {
        return { mode: InfraMode.Attach, endpoint: 'reg.local', credentialRef: DirectoryFixture.CredentialRef }
    }

    public static Env(hiveId: string): EnvironmentRecord
    {
        return {
            name: 'e1', type: EnvType.Runtime, template: Template.RuntimePostgres, environmentId: 't1',
            hostPort: 1, containerName: 'c', volumeName: 'v', bundleDir: 'b', createdAt: DirectoryFixture.Now,
            status: EnvStatus.Running, hiveId
        }
    }

    public async Seed(): Promise<void>
    {
        await this.directory.CreateClient({ id: 'c1', displayName: 'C1' })
        await this.directory.CreateTenant({ id: 't1', clientId: 'c1', displayName: 'T1' })
        await this.directory.CreateHive({ id: 'h1', tenantId: 't1', displayName: 'H1', cluster: DirectoryFixture.Cluster(), registry: DirectoryFixture.Registry() })
    }

    public async Dispose(): Promise<void>
    {
        await rm(this.dir, { recursive: true, force: true })
    }
}

test('CreateClient then CreateTenant then CreateHive persists the chain', async () =>
{
    const f = await DirectoryFixture.Create()
    try
    {
        await f.Seed()
        await f.directory.CreateClient({ id: 'c2', displayName: 'C2' })
        await f.directory.CreateTenant({ id: 't2', clientId: 'c2', displayName: 'T2' })
        assert.equal(f.directory.GetClient('c1')?.createdAt, DirectoryFixture.Now)
        assert.equal(f.directory.GetTenant('t1')?.clientId, 'c1')
        assert.equal(f.directory.GetHive('h1')?.tenantId, 't1')
        assert.equal(f.directory.ListClients().length, 2)
        assert.equal(f.directory.ListTenants().length, 2)
        assert.deepEqual(f.directory.ListTenants('c1').map(t => t.id), ['t1'])
        assert.deepEqual(f.directory.ListHives('t1').map(h => h.id), ['h1'])
        assert.equal(f.directory.ListHives('t2').length, 0)
    }
    finally
    {
        await f.Dispose()
    }
})

test('CreateClient with an existing id throws RecordExistsError', async () =>
{
    const f = await DirectoryFixture.Create()
    try
    {
        await f.directory.CreateClient({ id: 'c1', displayName: 'C1' })
        await assert.rejects(f.directory.CreateClient({ id: 'c1', displayName: 'again' }), RecordExistsError)
    }
    finally
    {
        await f.Dispose()
    }
})

test('CreateTenant for a missing client throws UnknownClientError', async () =>
{
    const f = await DirectoryFixture.Create()
    try
    {
        await assert.rejects(f.directory.CreateTenant({ id: 't1', clientId: 'nope', displayName: 'T' }), UnknownClientError)
    }
    finally
    {
        await f.Dispose()
    }
})

test('CreateHive for a missing tenant throws UnknownTenantError', async () =>
{
    const f = await DirectoryFixture.Create()
    try
    {
        await assert.rejects(
            f.directory.CreateHive({ id: 'h1', tenantId: 'nope', displayName: 'H', cluster: DirectoryFixture.Cluster(), registry: DirectoryFixture.Registry() }),
            UnknownTenantError)
    }
    finally
    {
        await f.Dispose()
    }
})

test('DeleteClient with a tenant throws ClientHasTenantsError', async () =>
{
    const f = await DirectoryFixture.Create()
    try
    {
        await f.Seed()
        await assert.rejects(f.directory.DeleteClient('c1'), ClientHasTenantsError)
        assert.ok(f.directory.GetClient('c1'))
    }
    finally
    {
        await f.Dispose()
    }
})

test('DeleteTenant with a hive throws TenantHasHivesError', async () =>
{
    const f = await DirectoryFixture.Create()
    try
    {
        await f.Seed()
        await assert.rejects(f.directory.DeleteTenant('t1'), TenantHasHivesError)
        await f.directory.DeleteHive('h1')
        await f.directory.DeleteTenant('t1')
        await f.directory.DeleteClient('c1')
        assert.equal(f.directory.ListClients().length, 0)
    }
    finally
    {
        await f.Dispose()
    }
})

test('DeleteHive bound by an environment throws HiveHasEnvironmentsError', async () =>
{
    const f = await DirectoryFixture.Create([DirectoryFixture.Env('h1')])
    try
    {
        await f.Seed()
        await assert.rejects(f.directory.DeleteHive('h1'), HiveHasEnvironmentsError)
        assert.ok(f.directory.GetHive('h1'))
    }
    finally
    {
        await f.Dispose()
    }
})

test('ValidateHivePlacement rejects a hive under a different tenant with HivePlacementError', async () =>
{
    const f = await DirectoryFixture.Create()
    try
    {
        await f.Seed()
        await f.directory.CreateTenant({ id: 't2', clientId: 'c1', displayName: 'T2' })
        f.directory.ValidateHivePlacement('t1', 'h1')
        assert.throws(() => f.directory.ValidateHivePlacement('t2', 'h1'), HivePlacementError)
        assert.throws(() => f.directory.ValidateHivePlacement('t1', 'missing'), HivePlacementError)
    }
    finally
    {
        await f.Dispose()
    }
})

test('CreateHive validates id and stores only ref names (no secret values)', async () =>
{
    const f = await DirectoryFixture.Create()
    try
    {
        await f.directory.CreateClient({ id: 'c1', displayName: 'C1' })
        await f.directory.CreateTenant({ id: 't1', clientId: 'c1', displayName: 'T1' })
        await assert.rejects(
            f.directory.CreateHive({ id: '../x', tenantId: 't1', displayName: 'H', cluster: DirectoryFixture.Cluster(), registry: DirectoryFixture.Registry() }))
        const hive = await f.directory.CreateHive({ id: 'h1', tenantId: 't1', displayName: 'H', cluster: DirectoryFixture.Cluster(), registry: DirectoryFixture.Registry() })
        assert.equal(hive.cluster.configRef, DirectoryFixture.ConfigRef)
        const json = await readFile(f.hivesPath, DirectoryFixture.Encoding)
        assert.ok(json.includes(DirectoryFixture.ConfigRef))
        assert.ok(!json.includes(DirectoryFixture.SecretValue))
    }
    finally
    {
        await f.Dispose()
    }
})
