import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConsoleAdvertRecord, IConsoleAdvertLookup } from '../console-advert-registry.js'
import { DesktopDiscoveryEndpoint } from '../desktop-discovery-endpoint.js'
import type { IPlatformEnvironmentSource } from '../desktop-discovery-endpoint.js'
import type { IDiscoveryDirectory } from '../desktop-tenant-matcher.js'
import { IngressTlsSource } from '../ingress-tls.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import { TenantAccountIndex } from '../tenant-account-index.js'

type Reply = { status: number; body: unknown; retryAfter: string | undefined }

class FakeDirectory implements IDiscoveryDirectory
{
    public constructor(private readonly tenants: readonly TenantRecord[], private readonly hives: readonly HiveRecord[] = [])
    {
    }

    public GetTenant(id: string): TenantRecord | undefined
    {
        return this.tenants.find(t => t.id === id)
    }

    public GetHive(id: string): HiveRecord | undefined
    {
        return this.hives.find(h => h.id === id)
    }

    public ListHives(tenantId: string): readonly HiveRecord[]
    {
        return this.hives.filter(h => h.tenantId === tenantId)
    }

    public ListTenants(): readonly TenantRecord[]
    {
        return this.tenants
    }
}

class FakeAdverts implements IConsoleAdvertLookup
{
    public constructor(private readonly records: readonly ConsoleAdvertRecord[])
    {
    }

    public ForTenant(tenantId: string): ConsoleAdvertRecord | undefined
    {
        return this.records.find(r => r.tenantId === tenantId)
    }

    public All(): readonly Readonly<ConsoleAdvertRecord>[]
    {
        return this.records
    }

    public HasFingerprint(): boolean
    {
        return false
    }
}

class DiscoveryFixture
{
    public static readonly Url = 'http://127.0.0.1:7002'
    public static readonly Ann = 'ann@acme.test'
    public static readonly Nobody = 'nobody@acme.test'
    public static readonly Path = '/api/desktop/discover'
    public static readonly Loopback = '127.0.0.1'
    public static readonly Utf8 = 'utf8'
    public static readonly EvilOrigin = 'http://evil.test'
    public static readonly ThrottleLimit = 10

    public static readonly Console = 'https://console-acme.localtest.me'

    public static Tenant(id: string, displayName: string, emailDomains?: string[]): TenantRecord
    {
        return { id, clientId: 'c1', displayName, createdAt: '2026-01-01T00:00:00.000Z', emailDomains }
    }

    public static ConsoleHive(id: string, tenantId: string): HiveRecord
    {
        return {
            id, tenantId, displayName: id, createdAt: '2026-01-01T00:00:00.000Z',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach },
            registry: { mode: InfraMode.Attach },
            console: { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } }
        }
    }

    public static Advert(tenantId: string, hiveId: string): ConsoleAdvertRecord
    {
        return {
            id: tenantId, tenantId, hiveId, consoleUrl: DiscoveryFixture.Console, fingerprints: [], emailDomains: [],
            firstReportedAt: '2026-11-04T10:00:00.000Z', reportedAt: '2026-11-04T10:00:00.000Z'
        }
    }

    public static Post(server: Server, payload: string, headers: Record<string, string> = {}): Promise<Reply>
    {
        const port = (server.address() as AddressInfo).port
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: DiscoveryFixture.Loopback, port, method: 'POST', path: DiscoveryFixture.Path, headers: { 'content-type': 'application/json', ...headers } }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () =>
                {
                    const text = Buffer.concat(chunks).toString(DiscoveryFixture.Utf8)
                    resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? undefined : JSON.parse(text), retryAfter: res.headers['retry-after'] as string | undefined })
                })
            })
            req.on('error', reject)
            req.end(payload)
        })
    }

    public static Email(email: string): string
    {
        return JSON.stringify({ email })
    }
}

describe('DesktopDiscoveryEndpoint', () =>
{
    let dir: string
    let index: TenantAccountIndex
    let server: Server

    async function Start(url: string | undefined, tenants: readonly TenantRecord[], hives: readonly HiveRecord[] = [], adverts: readonly ConsoleAdvertRecord[] = [],
        approved: ReadonlyMap<string, readonly string[]> = new Map(), platform?: IPlatformEnvironmentSource): Promise<void>
    {
        const endpoint = new DesktopDiscoveryEndpoint(index, new FakeDirectory(tenants, hives), url, DesktopDiscoveryEndpoint.NewThrottle(), new FakeAdverts(adverts),
            undefined, { StandingOf: tenantId => ({ approved: approved.get(tenantId) ?? [], revoked: [], verified: [] }) }, platform)
        server = createServer((req, res) =>
        {
            void endpoint.Handle(req, res)
        })
        await new Promise<void>(r => server.listen(0, DiscoveryFixture.Loopback, r))
    }

    beforeEach(async () =>
    {
        dir = await mkdtemp(join(tmpdir(), 'discover-'))
        index = new TenantAccountIndex(join(dir, 'tenant-accounts.json'))
        await index.Load()
        await index.Record('acme', 'owner', DiscoveryFixture.Ann)
    })

    afterEach(async () =>
    {
        await new Promise<void>(r => server.close(() => r()))
        await rm(dir, { recursive: true, force: true })
    })

    it('answers 200 with the tenants and the tenant plane url', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal(reply.status, 200)
        assert.deepEqual(reply.body, { tenants: [{ id: 'acme', displayName: 'Acme', consoleUrl: DiscoveryFixture.Url }], tenantPlaneUrl: DiscoveryFixture.Url })
    })

    it('sorts tenants by display name and skips unknown tenant ids', async () =>
    {
        await index.Record('zed', 'owner', DiscoveryFixture.Ann)
        await index.Record('gone', 'owner', DiscoveryFixture.Ann)
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('zed', 'Aardvark'), DiscoveryFixture.Tenant('acme', 'Acme')])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.deepEqual((reply.body as { tenants: unknown[] }).tenants, [
            { id: 'zed', displayName: 'Aardvark', consoleUrl: DiscoveryFixture.Url },
            { id: 'acme', displayName: 'Acme', consoleUrl: DiscoveryFixture.Url }
        ])
    })

    it('orders account matches before domain matches, then by display name', async () =>
    {
        await index.Record('zed', 'owner', DiscoveryFixture.Ann)
        await Start(DiscoveryFixture.Url, [
            DiscoveryFixture.Tenant('aard', 'Aardvark', ['acme.test']),
            DiscoveryFixture.Tenant('zed', 'Zebra'),
            DiscoveryFixture.Tenant('acme', 'Acme')
        ], [], [], new Map([['aard', ['acme.test']]]))
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.deepEqual((reply.body as { tenants: { id: string }[] }).tenants.map(t => t.id), ['acme', 'zed', 'aard'])
    })

    it('leaves out a control-plane tenant whose record domain is not approved', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('evil', 'Evil', ['victim.test'])])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email('someone@victim.test'))
        assert.equal(reply.status, 404)
    })

    it('returns the in-hive console url for an advertised tenant', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')], [DiscoveryFixture.ConsoleHive('h1', 'acme')], [DiscoveryFixture.Advert('acme', 'h1')])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal(reply.status, 200)
        assert.deepEqual(reply.body, { tenants: [{ id: 'acme', displayName: 'Acme', consoleUrl: DiscoveryFixture.Console }], tenantPlaneUrl: DiscoveryFixture.Url })
    })

    it('marks an in-hive tenant with platform environments', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')], [DiscoveryFixture.ConsoleHive('h1', 'acme')], [DiscoveryFixture.Advert('acme', 'h1')], new Map(),
            { HasEnvironmentsOf: tenantId => tenantId === 'acme' })
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal((reply.body as { tenants: { platformEnvironments?: boolean }[] }).tenants[0].platformEnvironments, true)
    })

    it('leaves the mark out for an in-hive tenant without platform environments', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')], [DiscoveryFixture.ConsoleHive('h1', 'acme')], [DiscoveryFixture.Advert('acme', 'h1')], new Map(),
            { HasEnvironmentsOf: () => false })
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal('platformEnvironments' in (reply.body as { tenants: object[] }).tenants[0], false)
    })

    it('never marks a control-plane tenant', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')], [], [], new Map(), { HasEnvironmentsOf: () => true })
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal('platformEnvironments' in (reply.body as { tenants: object[] }).tenants[0], false)
    })

    it('leaves the mark out when no source is composed', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')], [DiscoveryFixture.ConsoleHive('h1', 'acme')], [DiscoveryFixture.Advert('acme', 'h1')])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal('platformEnvironments' in (reply.body as { tenants: object[] }).tenants[0], false)
    })

    it('answers 404 no-account for an in-hive tenant that has not advertised yet', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')], [DiscoveryFixture.ConsoleHive('h1', 'acme')])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal(reply.status, 404)
        assert.deepEqual(reply.body, { error: 'no-account' })
    })

    it('answers 404 no-account for an unknown email', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Nobody))
        assert.equal(reply.status, 404)
        assert.deepEqual(reply.body, { error: 'no-account' })
    })

    it('answers 400 invalid-email for a missing, non-string or oversized email', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')])
        for (const payload of ['{}', '{"email":5}', 'not json', DiscoveryFixture.Email('a'.repeat(255))])
        {
            const reply = await DiscoveryFixture.Post(server, payload)
            assert.equal(reply.status, 400, payload.slice(0, 20))
            assert.deepEqual(reply.body, { error: 'invalid-email' })
        }
    })

    it('answers 503 unavailable when no tenant plane url is configured', async () =>
    {
        await Start(undefined, [DiscoveryFixture.Tenant('acme', 'Acme')])
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal(reply.status, 503)
        assert.deepEqual(reply.body, { error: 'unavailable' })
    })

    it('answers 403 when an Origin header is present and does not count it against the throttle', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')])
        for (let i = 0; i < DiscoveryFixture.ThrottleLimit + 5; i++)
        {
            assert.equal((await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann), { origin: DiscoveryFixture.EvilOrigin })).status, 403)
        }
        assert.equal((await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))).status, 200)
    })

    it('throttles the 11th request in a minute from one address with Retry-After', async () =>
    {
        await Start(DiscoveryFixture.Url, [DiscoveryFixture.Tenant('acme', 'Acme')])
        for (let i = 0; i < DiscoveryFixture.ThrottleLimit; i++)
        {
            assert.equal((await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Nobody))).status, 404)
        }
        const reply = await DiscoveryFixture.Post(server, DiscoveryFixture.Email(DiscoveryFixture.Ann))
        assert.equal(reply.status, 429)
        assert.ok(Number(reply.retryAfter) > 0)
    })
})
