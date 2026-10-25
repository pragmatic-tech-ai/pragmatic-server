import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TenantAdminServer } from '../tenant-admin-server.js'
import { SeededTenantDirectory } from '../tenant-api/seeded-tenant-directory.js'
import type { IRolloutClient } from '../tenant-api/rollout-client.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'

class FakeRolloutClient implements IRolloutClient
{
    public ManifestsFor(): never[] { return [] }
    public StatusFor(): never { throw new Error('unused') }
    public AdoptTarget(): Promise<void> { return Promise.resolve() }
}

describe('TenantAdminServer', () =>
{
    const DataRootVar = 'PRAGMATIC_TENANT_ADMIN_DATA_ROOT'
    const PortVar = 'PRAGMATIC_TENANT_ADMIN_PORT'
    const DomainVar = 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN'
    const tenant: TenantRecord = { id: 'acme', clientId: 'c1', displayName: 'Acme', createdAt: '2026-01-01T00:00:00Z' }
    const hive: HiveRecord = {
        id: 'h1', tenantId: 'acme', displayName: 'Hive', createdAt: '2026-01-01T00:00:00Z',
        cluster: { kind: 'kind' } as unknown as HiveRecord['cluster'],
        registry: { kind: 'local' } as unknown as HiveRecord['registry'],
    }
    let root = ''

    const env = (): NodeJS.ProcessEnv => ({ [DataRootVar]: root, [PortVar]: '7100', [DomainVar]: 'admin.example.com' })
    const writeSeed = (): void => writeFileSync(join(root, 'seed.json'), JSON.stringify({ tenant, hives: [hive] }))

    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tenant-admin-server-')) })
    afterEach(() => { rmSync(root, { recursive: true, force: true }) })

    it('ReadConfig parses env and applies defaults', () =>
    {
        const cfg = TenantAdminServer.ReadConfig(env())
        assert.equal(cfg.dataRoot, root)
        assert.equal(cfg.port, 7100)
        assert.equal(cfg.baseDomain, 'admin.example.com')
        assert.equal(cfg.bind, '127.0.0.1')
        assert.equal(cfg.scheme, 'https')
        assert.equal(cfg.secureCookie, false)
    })

    for (const missing of [DataRootVar, PortVar, DomainVar])
    {
        it(`ReadConfig throws a clear error when ${missing} is missing`, () =>
        {
            const e = env()
            delete e[missing]
            assert.throws(() => TenantAdminServer.ReadConfig(e), new RegExp(missing))
        })
    }

    it('LoadSeed builds a SeededTenantDirectory resolving the seeded tenant and hive', () =>
    {
        writeSeed()
        const dir = TenantAdminServer.LoadSeed(root)
        assert.ok(dir instanceof SeededTenantDirectory)
        assert.equal(dir.GetTenant('acme')?.displayName, 'Acme')
        assert.equal(dir.GetTenant('other'), undefined)
        assert.equal(dir.ListHives('acme').length, 1)
    })

    it('LoadSeed throws a clear error when seed.json is missing or malformed', () =>
    {
        assert.throws(() => TenantAdminServer.LoadSeed(root), /seed\.json/)
        writeFileSync(join(root, 'seed.json'), JSON.stringify({ hives: [] }))
        assert.throws(() => TenantAdminServer.LoadSeed(root), /seed\.json/)
    })

    it('Compose throws when the master key is missing', async () =>
    {
        writeSeed()
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env()), new FakeRolloutClient())
        await assert.rejects(() => server.Compose(), /master\.key/)
    })

    it('Compose wires the seeded directory and injected rollout client under its own data root', async () =>
    {
        writeSeed()
        writeFileSync(join(root, 'master.key'), randomBytes(32))
        const rollout = new FakeRolloutClient()
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env()), rollout)
        const composition = await server.Compose()
        assert.equal(composition.rollout, rollout)
        assert.ok(composition.directory instanceof SeededTenantDirectory)
        assert.equal(composition.directory.GetTenant('acme')?.id, 'acme')
        assert.ok(composition.plane.endpoint)
        assert.ok(composition.plane.api)
        assert.ok(composition.plane.isDurable)
        assert.ok(composition.host)
        assert.ok(composition.monitor)
    })
})
