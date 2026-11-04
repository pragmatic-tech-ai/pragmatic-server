import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientRegistry } from '../client-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { TenantAccountIndex } from '../tenant-account-index.js'
import { TenantRegistry } from '../tenant-registry.js'

class IndexFixture
{
    public static readonly Prefix = 'acctidx-'
    public static readonly IndexFile = 'tenant-accounts.json'
    public static readonly ClientId = 'c1'
    public static readonly Ann = 'Ann@Acme.test'
    public static readonly AnnQuery = '  ann@ACME.test '
    public static readonly NewEmail = 'new@acme.test'
    public static readonly Acme = 'acme'
    public static readonly Beta = 'beta'
    public static readonly Owner = 'owner'
    public static readonly P1 = 'p1'

    public static async NewDirectory(dir: string): Promise<PlatformDirectory>
    {
        const directory = new PlatformDirectory(
            new ClientRegistry(join(dir, 'clients.json')),
            new TenantRegistry(join(dir, 'tenants.json')),
            new HiveRegistry(join(dir, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: IndexFixture.ClientId, displayName: 'C' })
        return directory
    }
}

describe('TenantAccountIndex', () =>
{
    let dir: string
    let index: TenantAccountIndex

    beforeEach(async () =>
    {
        dir = await mkdtemp(join(tmpdir(), IndexFixture.Prefix))
        index = new TenantAccountIndex(join(dir, IndexFixture.IndexFile))
        await index.Load()
    })

    afterEach(async () =>
    {
        await rm(dir, { recursive: true, force: true })
    })

    it('finds the tenant whatever the case or surrounding spaces', async () =>
    {
        await index.Record(IndexFixture.Acme, IndexFixture.P1, IndexFixture.Ann)
        assert.deepEqual(index.TenantsFor(IndexFixture.AnnQuery), [IndexFixture.Acme])
    })

    it('returns every tenant an email belongs to', async () =>
    {
        await index.Record(IndexFixture.Acme, IndexFixture.P1, IndexFixture.Ann)
        await index.Record(IndexFixture.Beta, IndexFixture.Owner, IndexFixture.Ann)
        await index.Record(IndexFixture.Beta, IndexFixture.P1, IndexFixture.Ann)
        assert.deepEqual([...index.TenantsFor(IndexFixture.Ann)].sort(), [IndexFixture.Acme, IndexFixture.Beta])
    })

    it('replaces a principal old email', async () =>
    {
        await index.Record(IndexFixture.Acme, IndexFixture.P1, IndexFixture.Ann)
        await index.Record(IndexFixture.Acme, IndexFixture.P1, IndexFixture.NewEmail)
        assert.deepEqual(index.TenantsFor(IndexFixture.Ann), [])
        assert.deepEqual(index.TenantsFor(IndexFixture.NewEmail), [IndexFixture.Acme])
    })

    it('forgets a deleted tenant', async () =>
    {
        await index.Record(IndexFixture.Acme, IndexFixture.P1, IndexFixture.Ann)
        await index.Record(IndexFixture.Beta, IndexFixture.P1, IndexFixture.Ann)
        await index.ForgetTenant(IndexFixture.Acme)
        assert.deepEqual(index.TenantsFor(IndexFixture.Ann), [IndexFixture.Beta])
    })

    it('survives a reload', async () =>
    {
        await index.Record(IndexFixture.Acme, IndexFixture.P1, IndexFixture.Ann)
        const again = new TenantAccountIndex(join(dir, IndexFixture.IndexFile))
        await again.Load()
        assert.deepEqual(again.TenantsFor(IndexFixture.Ann), [IndexFixture.Acme])
    })

    it('back-fills owners already in the directory, once', async () =>
    {
        const directory = await IndexFixture.NewDirectory(dir)
        await directory.CreateProvisionedTenant({ id: IndexFixture.Acme, clientId: IndexFixture.ClientId, displayName: 'Acme', ownerEmail: IndexFixture.Ann, ownerPrincipalId: IndexFixture.Owner, idpBaseUrl: 'https://idp.test' })
        await directory.CreateTenant({ id: IndexFixture.Beta, clientId: IndexFixture.ClientId, displayName: 'Beta' })
        assert.equal(await index.BackfillFrom(directory), 1)
        assert.deepEqual(index.TenantsFor(IndexFixture.Ann), [IndexFixture.Acme])
        assert.equal(await index.BackfillFrom(directory), 0)
    })
})
