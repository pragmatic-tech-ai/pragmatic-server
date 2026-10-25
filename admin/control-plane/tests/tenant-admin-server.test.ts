import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TenantAdminServer } from '../tenant-admin-server.js'
import { SeededTenantDirectory } from '../tenant-api/seeded-tenant-directory.js'
import { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import { RolloutUnavailableError, type IRolloutClient } from '../tenant-api/rollout-client.js'
import { UnconfiguredRolloutClient } from '../tenant-api/unconfigured-rollout-client.js'
import { HttpRolloutClient } from '../tenant-api/http-rollout-client.js'
import { EnvironmentPlacement } from '../environment-placement.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

class FakeRolloutClient implements IRolloutClient
{
    public async ManifestsFor(): Promise<never[]>
    {
        return []
    }

    public async StatusFor(): Promise<never>
    {
        throw new Error(Names.Unused)
    }

    public AdoptTarget(): Promise<void>
    {
        return Promise.resolve()
    }
}

class Names
{
    public static readonly DataRootVar = 'PRAGMATIC_TENANT_ADMIN_DATA_ROOT'
    public static readonly PortVar = 'PRAGMATIC_TENANT_ADMIN_PORT'
    public static readonly DomainVar = 'PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN'
    public static readonly SeedFile = 'seed.json'
    public static readonly MasterKeyFile = 'master.key'
    public static readonly TenantId = 'acme'
    public static readonly TenantName = 'Acme'
    public static readonly OtherTenantId = 'other'
    public static readonly HiveId = 'h1'
    public static readonly SecondHiveId = 'h2'
    public static readonly Created = '2026-01-01T00:00:00Z'
    public static readonly Expires = '2099-01-01T00:00:00Z'
    public static readonly Domain = 'admin.example.com'
    public static readonly Port = '7100'
    public static readonly DefaultBind = '127.0.0.1'
    public static readonly DefaultScheme = 'https'
    public static readonly TempPrefix = 'tenant-admin-server-'
    public static readonly FreshDir = 'fresh'
    public static readonly Unused = 'unused'
    public static readonly HivePattern = /hive/
    public static readonly NoRolloutPattern = /No rollout client/
    public static readonly ManifestsPath = '/tenant-api/manifests'
    public static readonly RolloutPathSuffix = '/rollout'
    public static readonly HivesPathPrefix = '/tenant-api/hives/'
    public static readonly Get = 'GET'
    public static readonly KeyBytes = 32
    public static readonly Unavailable = 503
}

describe('TenantAdminServer', () =>
{
    const tenant: TenantRecord = { id: Names.TenantId, clientId: 'c1', displayName: Names.TenantName, createdAt: Names.Created }
    const hive: HiveRecord = {
        id: Names.HiveId, tenantId: Names.TenantId, displayName: 'Hive', createdAt: Names.Created,
        cluster: { kind: 'kind' } as unknown as HiveRecord['cluster'],
        registry: { kind: 'local' } as unknown as HiveRecord['registry'],
    }
    let root = ''

    const env = (): NodeJS.ProcessEnv => ({ [Names.DataRootVar]: root, [Names.PortVar]: Names.Port, [Names.DomainVar]: Names.Domain })
    const writeSeedJson = (body: unknown): void => writeFileSync(join(root, Names.SeedFile), JSON.stringify(body))
    const writeSeed = (): void => writeSeedJson({ tenant, hives: [hive] })

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), Names.TempPrefix))
    })

    afterEach(() =>
    {
        rmSync(root, { recursive: true, force: true })
    })

    it('ReadConfig parses env and applies defaults', () =>
    {
        const cfg = TenantAdminServer.ReadConfig(env())
        assert.equal(cfg.dataRoot, root)
        assert.equal(cfg.port, Number(Names.Port))
        assert.equal(cfg.baseDomain, Names.Domain)
        assert.equal(cfg.bind, Names.DefaultBind)
        assert.equal(cfg.scheme, Names.DefaultScheme)
        assert.equal(cfg.secureCookie, false)
    })

    for (const missing of [Names.DataRootVar, Names.PortVar, Names.DomainVar])
    {
        it(`ReadConfig throws a clear error when ${missing} is missing`, () =>
        {
            const e = env()
            delete e[missing]
            assert.throws(() => TenantAdminServer.ReadConfig(e), new RegExp(missing))
        })
    }

    for (const badPort of ['abc', '0', '70000', '1.5'])
    {
        it(`ReadConfig throws a clear error for invalid port ${badPort}`, () =>
        {
            const e = env()
            e[Names.PortVar] = badPort
            assert.throws(() => TenantAdminServer.ReadConfig(e), new RegExp(Names.PortVar))
        })
    }

    it('LoadSeed builds a SeededTenantDirectory resolving the seeded tenant and hive', () =>
    {
        writeSeed()
        const dir = TenantAdminServer.LoadSeed(root)
        assert.ok(dir instanceof SeededTenantDirectory)
        assert.equal(dir.GetTenant(Names.TenantId)?.displayName, Names.TenantName)
        assert.equal(dir.GetTenant(Names.OtherTenantId), undefined)
        assert.equal(dir.ListHives(Names.TenantId).length, 1)
    })

    it('SeededTenantDirectory.ListHives() with no argument returns every seeded hive', () =>
    {
        const dir = new SeededTenantDirectory({ tenant, hives: [hive, { ...hive, id: Names.SecondHiveId }] })
        assert.deepEqual(dir.ListHives().map(h => h.id), [Names.HiveId, Names.SecondHiveId])
        assert.equal(dir.ListHives(Names.OtherTenantId).length, 0)
    })

    it('LoadSeed throws a clear error when seed.json is missing or malformed', () =>
    {
        assert.throws(() => TenantAdminServer.LoadSeed(root), new RegExp(Names.SeedFile))
        writeSeedJson({ hives: [] })
        assert.throws(() => TenantAdminServer.LoadSeed(root), new RegExp(Names.SeedFile))
    })

    it('LoadSeed rejects malformed hive elements', () =>
    {
        writeSeedJson({ tenant, hives: [{ id: Names.HiveId }] })
        assert.throws(() => TenantAdminServer.LoadSeed(root), Names.HivePattern)
        writeSeedJson({ tenant, hives: [null] })
        assert.throws(() => TenantAdminServer.LoadSeed(root), Names.HivePattern)
    })

    it('Compose fails on a missing seed or master key and leaves no data dir behind', async () =>
    {
        const fresh = join(root, Names.FreshDir)
        const e = env()
        e[Names.DataRootVar] = fresh
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(e), new FakeRolloutClient())
        await assert.rejects(() => server.Compose(), new RegExp(Names.SeedFile))
        assert.equal(existsSync(fresh), false)
        writeSeed()
        const second = new TenantAdminServer(TenantAdminServer.ReadConfig(env()), new FakeRolloutClient())
        await assert.rejects(() => second.Compose(), new RegExp(Names.MasterKeyFile))
    })

    it('Compose wires the seeded directory and injected rollout client under its own data root', async () =>
    {
        writeSeed()
        writeFileSync(join(root, Names.MasterKeyFile), randomBytes(Names.KeyBytes))
        const rollout = new FakeRolloutClient()
        const server = new TenantAdminServer(TenantAdminServer.ReadConfig(env()), rollout)
        const composition = await server.Compose()
        assert.equal(composition.rollout, rollout)
        assert.ok(composition.directory instanceof SeededTenantDirectory)
        assert.equal(composition.directory.GetTenant(Names.TenantId)?.id, Names.TenantId)
        assert.ok(composition.plane.endpoint)
        assert.ok(composition.plane.api)
        assert.ok(composition.plane.isDurable)
        assert.ok(composition.host)
        assert.ok(composition.monitor)
    })
})

describe('UnconfiguredRolloutClient', () =>
{
    it('fails closed on every method', async () =>
    {
        const client = new UnconfiguredRolloutClient()
        await assert.rejects(() => client.ManifestsFor(Names.TenantId), RolloutUnavailableError)
        await assert.rejects(() => client.StatusFor(Names.HiveId), RolloutUnavailableError)
        await assert.rejects(() => client.AdoptTarget(Names.HiveId, Names.Unused), RolloutUnavailableError)
    })

    it('TenantApiEndpoint answers 503 with a clear message for manifests and rollout status', async () =>
    {
        const hive = { id: Names.HiveId, tenantId: Names.TenantId }
        const directory = { GetHive: () => hive, GetTenant: () => undefined, ListHives: () => [hive] } as unknown as never
        const stub = {} as unknown as never
        const endpoint = new TenantApiEndpoint(stub, directory, new UnconfiguredRolloutClient(), new HiveOrchestratorFactory(), new EnvironmentPlacement(directory))
        const session: TenantSession = { id: 's', tenantId: Names.TenantId, principalId: 'p', expiresAt: Names.Expires }
        for (const path of [Names.ManifestsPath, Names.HivesPathPrefix + Names.HiveId + Names.RolloutPathSuffix])
        {
            let status = 0
            let body = ''
            const res = { writeHead: (s: number) => { status = s }, end: (b: string) => { body = b } }
            await endpoint.Handle({ method: Names.Get } as unknown as IncomingMessage, res as unknown as ServerResponse, path, session)
            assert.equal(status, Names.Unavailable)
            assert.match(body, Names.NoRolloutPattern)
        }
    })
})

describe('TenantAdminServer.RolloutClientFrom', () =>
{
    it('uses the unconfigured default when no rollout URL is set', () =>
    {
        assert.ok(TenantAdminServer.RolloutClientFrom({}) instanceof UnconfiguredRolloutClient)
    })

    it('builds the HTTP client when the URL, token and hive id are set', () =>
    {
        const client = TenantAdminServer.RolloutClientFrom({
            PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL: 'http://channel.example:7000',
            PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN: 'tok',
            PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID: 'hive-a',
        })
        assert.ok(client instanceof HttpRolloutClient)
    })

    it('fails naming the variable when the URL is set without a token', () =>
    {
        assert.throws(
            () => TenantAdminServer.RolloutClientFrom({ PRAGMATIC_TENANT_ADMIN_ROLLOUT_URL: 'http://c:1', PRAGMATIC_TENANT_ADMIN_ROLLOUT_HIVE_ID: 'h' }),
            /PRAGMATIC_TENANT_ADMIN_ROLLOUT_TOKEN/)
    })
})
