import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SeededTenantDirectory } from '../tenant-api/seeded-tenant-directory.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'

class SeedFixture
{
    public static readonly TenantId = 'acme-prod'
    public static readonly ForeignTenantId = 'other-tenant'
    public static readonly HiveId = 'hive-1'
    public static readonly ForeignHiveId = 'hive-x'
    public static readonly ClientId = 'acme'
    public static readonly Created = '2026-10-22T00:00:00.000Z'

    public static Tenant(): TenantRecord
    {
        return { id: SeedFixture.TenantId, clientId: SeedFixture.ClientId, displayName: 'Acme Prod', createdAt: SeedFixture.Created }
    }

    public static Hive(id: string, tenantId: string): HiveRecord
    {
        return { id, tenantId, displayName: id, cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach }, createdAt: SeedFixture.Created }
    }

    public static Directory(): SeededTenantDirectory
    {
        return new SeededTenantDirectory({ tenant: SeedFixture.Tenant(), hives: [SeedFixture.Hive(SeedFixture.HiveId, SeedFixture.TenantId)] })
    }
}

test('GetTenant resolves the seeded tenant exactly', () =>
{
    assert.deepEqual(SeedFixture.Directory().GetTenant(SeedFixture.TenantId), SeedFixture.Tenant())
})

test('GetTenant for a foreign tenant is undefined', () =>
{
    assert.equal(SeedFixture.Directory().GetTenant(SeedFixture.ForeignTenantId), undefined)
})

test('GetHive returns a seeded hive and undefined for a foreign hive', () =>
{
    const dir = SeedFixture.Directory()
    assert.deepEqual(dir.GetHive(SeedFixture.HiveId), SeedFixture.Hive(SeedFixture.HiveId, SeedFixture.TenantId))
    assert.equal(dir.GetHive(SeedFixture.ForeignHiveId), undefined)
})

test('ListHives returns seeded hives for the seeded tenant and empty for a foreign tenant', () =>
{
    const dir = SeedFixture.Directory()
    assert.deepEqual(dir.ListHives(SeedFixture.TenantId), [SeedFixture.Hive(SeedFixture.HiveId, SeedFixture.TenantId)])
    assert.deepEqual(dir.ListHives(SeedFixture.ForeignTenantId), [])
})
