import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevCa, IdpTlsMaterial } from '../../../src/idp/dev-ca.js'
import { IdpAdminEndpoint } from '../../../src/idp/idp-admin-endpoint.js'
import { IdpClientStore } from '../../../src/idp/idp-client-store.js'
import { IdpHost, IdpRealmSet } from '../../../src/idp/idp-host.js'
import { IdpRealm } from '../../../src/idp/idp-realm.js'
import { IdpSigningKey } from '../../../src/idp/idp-signing-key.js'
import { IdpSsoSessionStore } from '../../../src/idp/idp-sso-session.js'
import { InMemoryAuthorizationCodeStore } from '../../../src/idp/authorization-code-store.js'
import { FileIdentityStores } from '@pragmatic-tech-ai/todl-identity-node'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { IdpAdminClient } from '../idp-admin-client.js'
import type { IdpAdminClientOptions, IdpAdminClientRegistration } from '../idp-admin-client.js'
import type { IdpConnection, IIdpService } from '../idp-service.js'
import { PlatformDirectory } from '../platform-directory.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import type { EnvironmentRecord } from '../environment-record.js'
import type { IEnvironmentLookup } from '../platform-directory.js'
import { TenantAdminClientRegistry } from '../tenant-auth/tenant-admin-client-record.js'
import { TenantLoginError, TenantOidcRelyingParty } from '../tenant-auth/tenant-oidc-relying-party.js'
import type { TenantAdminDurability } from '../tenant-auth/tenant-oidc-relying-party.js'

/** A raw user-agent exchange result; redirects are read, never followed. */
class BrowserResponse
{
    public constructor(
        public readonly Status: number,
        public readonly Location: string | undefined,
        public readonly Body: string)
    {
    }
}

/** Plays the browser: raw https GET/POST trusting the IdP dev CA, redirects captured not followed. */
class Browser
{
    private static readonly FormContentType = 'application/x-www-form-urlencoded'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ContentLengthHeader = 'Content-Length'
    private static readonly GetMethod = 'GET'
    private static readonly PostMethod = 'POST'

    public constructor(private readonly ca: Buffer)
    {
    }

    public Get(url: string): Promise<BrowserResponse>
    {
        return this.send(Browser.GetMethod, url, undefined)
    }

    public PostForm(url: string, fields: ReadonlyMap<string, string>): Promise<BrowserResponse>
    {
        return this.send(Browser.PostMethod, url, new URLSearchParams([...fields]).toString())
    }

    private send(method: string, url: string, body: string | undefined): Promise<BrowserResponse>
    {
        const headers: Record<string, string> = {}
        if (body !== undefined)
        {
            headers[Browser.ContentTypeHeader] = Browser.FormContentType
            headers[Browser.ContentLengthHeader] = String(Buffer.byteLength(body))
        }
        return new Promise<BrowserResponse>((resolve, reject) =>
        {
            const req = httpsRequest(url, { ca: this.ca, method, headers }, (res: IncomingMessage) =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () => resolve(new BrowserResponse(res.statusCode ?? 0, res.headers.location, Buffer.concat(chunks).toString('utf8'))))
                res.on('error', reject)
            })
            req.on('error', reject)
            if (body !== undefined)
            {
                req.write(body)
            }
            req.end()
        })
    }
}

/** An IIdpService stub that returns one already-running in-process IdP connection. */
class StubIdp implements IIdpService
{
    public constructor(private readonly conn: IdpConnection)
    {
    }

    public async EnsureForTenant(): Promise<IdpConnection>
    {
        return this.conn
    }
}

class EmptyEnvironments implements IEnvironmentLookup
{
    public List(): readonly EnvironmentRecord[]
    {
        return []
    }
}

/** Stands up a real in-process IdpHost (bound to a known free port so discovery issuers carry that port),
 *  pre-creates the tenant realm and one login-able account, and hands the body a connection + a CA browser. */
class IdpFixture
{
    public static readonly TenantId = 'acme'
    public static readonly AdminToken = 'fixture-admin-token-0a1b2c3d4e5f'
    public static readonly OwnerEmail = 'owner@acme.test'
    public static readonly OwnerPrincipalId = 'user-owner-0001'
    public static readonly OwnerPassword = 'correct-horse-battery-staple'
    public static readonly OwnerDisplayName = 'Acme Owner'
    public static readonly CallbackUrl = 'https://admin.acme.test/tenant-auth/oidc/callback'
    private static readonly Host = '127.0.0.1'

    /** Builds the confidential-admin IdpAdminClient the relying-party asks for, over the tenant's own CA. */
    public static AdminClientFor(conn: IdpConnection): IdpAdminClient
    {
        return new IdpAdminClient({ baseUrl: conn.baseUrl, adminToken: conn.adminToken, ca: conn.ca })
    }

    /** An empty, loaded PlatformDirectory (the relying-party only reads display names from it). */
    public static async Directory(): Promise<PlatformDirectory>
    {
        const dir = await mkdtemp(join(tmpdir(), 'tenant-oidc-dir-'))
        const directory = new PlatformDirectory(
            new ClientRegistry(join(dir, 'clients.json')),
            new TenantRegistry(join(dir, 'tenants.json')),
            new HiveRegistry(join(dir, 'hives.json')),
            new EmptyEnvironments())
        await directory.Load()
        return directory
    }

    public static async With(body: (conn: IdpConnection, browser: Browser) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), 'tenant-oidc-'))
        let host: IdpHost | undefined
        try
        {
            const caFiles = DevCa.EnsureAt(join(dir, 'tls'), IdpFixture.Host)
            const ca = readFileSync(caFiles.caFile)
            const tls = IdpTlsMaterial.Load({ certFile: caFiles.certFile, keyFile: caFiles.keyFile })
            const key = await IdpSigningKey.LoadOrCreate(join(dir, 'signing.pem'))
            const realmsDir = join(dir, 'realms')
            const masterKey = randomBytes(32)
            const realms = new IdpRealmSet([], (id, name) => IdpRealm.OpenFor(realmsDir, id, name, masterKey))
            const clients = new IdpClientStore()
            const admin = new IdpAdminEndpoint(IdpFixture.AdminToken, realms, clients)
            const port = await IdpFixture.FreePort()
            const baseUrl = 'https://' + IdpFixture.Host + ':' + port
            host = new IdpHost(baseUrl, key, realms, clients, new InMemoryAuthorizationCodeStore(), new IdpSsoSessionStore(), tls, true, admin)
            await host.Listen(port, IdpFixture.Host)
            const conn: IdpConnection = { baseUrl, ca, adminToken: IdpFixture.AdminToken, adminTokenRef: 'admin-token', caDir: join(dir, 'tls') }
            const client = new IdpAdminClient({ baseUrl, adminToken: IdpFixture.AdminToken, ca })
            await client.EnsureRealm(IdpFixture.TenantId, 'Acme')
            await client.SeedAccount(IdpFixture.TenantId, { email: IdpFixture.OwnerEmail, principalId: IdpFixture.OwnerPrincipalId, displayName: IdpFixture.OwnerDisplayName, password: IdpFixture.OwnerPassword })
            await body(conn, new Browser(ca))
        }
        finally
        {
            if (host !== undefined)
            {
                await host.Close()
            }
            rmSync(dir, { recursive: true, force: true })
        }
    }

    private static FreePort(): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const server = createNetServer()
            server.once('error', reject)
            server.listen(0, IdpFixture.Host, () =>
            {
                const port = (server.address() as AddressInfo).port
                server.close(() => resolve(port))
            })
        })
    }
}

test('Begin returns an authorize URL at the tenant IdP carrying the admin client, callback, state and PKCE', async () =>
{
    await IdpFixture.With(async (conn, _browser) =>
    {
        const rp = new TenantOidcRelyingParty(new StubIdp(conn), await IdpFixture.Directory(), IdpFixture.AdminClientFor, IdpFixture.CallbackUrl)
        const begin = await rp.Begin(IdpFixture.TenantId)
        const url = new URL(begin.Url)
        assert.equal(url.origin, new URL(conn.baseUrl).origin)
        assert.equal(url.searchParams.get('response_type'), 'code')
        assert.equal(url.searchParams.get('client_id'), TenantOidcRelyingParty.AdminClientId)
        assert.equal(url.searchParams.get('redirect_uri'), IdpFixture.CallbackUrl)
        assert.ok((url.searchParams.get('state') ?? '').length > 0)
        assert.ok((url.searchParams.get('code_challenge') ?? '').length > 0)
        assert.equal(begin.State, url.searchParams.get('state'))
    })
})

test('Complete drives the real IdP login to a code and returns the seeded owner principalId', async () =>
{
    await IdpFixture.With(async (conn, browser) =>
    {
        const rp = new TenantOidcRelyingParty(new StubIdp(conn), await IdpFixture.Directory(), IdpFixture.AdminClientFor, IdpFixture.CallbackUrl)
        const begin = await rp.Begin(IdpFixture.TenantId)

        const loginPage = await browser.Get(begin.Url)
        assert.equal(loginPage.Status, 200)
        assert.ok(loginPage.Body.includes('<form'))

        const redirect = await browser.PostForm(begin.Url, new Map([['email', IdpFixture.OwnerEmail], ['password', IdpFixture.OwnerPassword]]))
        assert.equal(redirect.Status, 302)
        assert.ok(redirect.Location !== undefined)
        const target = new URL(redirect.Location!)
        assert.equal(target.origin + target.pathname, IdpFixture.CallbackUrl)
        const code = target.searchParams.get('code') ?? ''
        assert.equal(target.searchParams.get('state'), begin.State)
        assert.ok(code.length > 0)

        const result = await rp.Complete(IdpFixture.TenantId, code, begin.State)
        assert.equal(result.principalId, IdpFixture.OwnerPrincipalId)
        assert.equal(result.email, IdpFixture.OwnerEmail)
    })
})

/** An injectable, movable clock whose Now() closes over its mutable current value. */
class Clock
{
    public constructor(private current: number)
    {
    }

    public readonly Now = (): number => this.current

    public Advance(ms: number): void
    {
        this.current += ms
    }
}

/** A real IdpAdminClient that records the secret of every RegisterClient call before delegating upstream. */
class RecordingAdminClient extends IdpAdminClient
{
    public constructor(options: IdpAdminClientOptions, private readonly sink: string[])
    {
        super(options)
    }

    public override async RegisterClient(tenantId: string, client: IdpAdminClientRegistration): Promise<void>
    {
        this.sink.push(client.secret)
        await super.RegisterClient(tenantId, client)
    }
}

/** A RegisterClient that always rejects, to prove no secret leaks when IdP registration fails. */
class ThrowingAdminClient extends IdpAdminClient
{
    private static readonly FailureMessage = 'idp register rejected'

    public override RegisterClient(): Promise<void>
    {
        return Promise.reject(new Error(ThrowingAdminClient.FailureMessage))
    }
}

/** Builds a durable `TenantAdminDurability` over a throwaway temp store + registry, and reads secrets back. */
class DurableFixture
{
    public static readonly GenericLoginMessage = 'Tenant administrator login failed'

    private static readonly TempPrefix = 'tenant-oidc-durable-'
    private static readonly StoreDirName = 'oidc-secrets'
    private static readonly RegistryFileName = 'tenant-admin-clients.json'
    private static readonly SecretRefPrefix = 'tenant-admin-oidc/'
    private static readonly MasterKeyBytes = 32
    private static readonly DummyBaseUrl = 'https://idp.invalid'
    private static readonly DummyAdminToken = 'dummy-admin-token'
    private static readonly DummyAdminTokenRef = 'dummy-admin-token-ref'
    private static readonly DummyCaDir = 'dummy-ca-dir'

    private constructor(
        public readonly storeRoot: string,
        public readonly masterKey: Buffer,
        public readonly registry: TenantAdminClientRegistry,
        private readonly registryFile: string)
    {
    }

    public static async Create(): Promise<DurableFixture>
    {
        const dir = await mkdtemp(join(tmpdir(), DurableFixture.TempPrefix))
        const registryFile = join(dir, DurableFixture.RegistryFileName)
        const registry = new TenantAdminClientRegistry(registryFile)
        await registry.Load()
        return new DurableFixture(join(dir, DurableFixture.StoreDirName), randomBytes(DurableFixture.MasterKeyBytes), registry, registryFile)
    }

    public static get DummyConn(): IdpConnection
    {
        return {
            baseUrl: DurableFixture.DummyBaseUrl,
            ca: Buffer.alloc(0),
            adminToken: DurableFixture.DummyAdminToken,
            adminTokenRef: DurableFixture.DummyAdminTokenRef,
            caDir: DurableFixture.DummyCaDir
        }
    }

    public static ThrowingFactory(): (conn: IdpConnection) => IdpAdminClient
    {
        return (conn: IdpConnection): IdpAdminClient => new ThrowingAdminClient({ baseUrl: conn.baseUrl, adminToken: conn.adminToken, ca: conn.ca })
    }

    public static RecordingFactory(sink: string[]): (conn: IdpConnection) => IdpAdminClient
    {
        return (conn: IdpConnection): IdpAdminClient => new RecordingAdminClient({ baseUrl: conn.baseUrl, adminToken: conn.adminToken, ca: conn.ca }, sink)
    }

    public Durability(now: () => number, ttlMs: number): TenantAdminDurability
    {
        return this.DurabilityWith(this.registry, now, ttlMs)
    }

    public DurabilityWith(registry: TenantAdminClientRegistry, now: () => number, ttlMs: number): TenantAdminDurability
    {
        return { storeRoot: this.storeRoot, masterKey: this.masterKey, registry, secretTtlMs: ttlMs, now }
    }

    public SecretRef(tenantId: string): string
    {
        return DurableFixture.SecretRefPrefix + tenantId
    }

    public async StoredSecret(tenantId: string): Promise<string | null>
    {
        const stores = await FileIdentityStores.Open(new NodeFsStorage(this.storeRoot), this.masterKey)
        return stores.Secrets.Get(this.SecretRef(tenantId))
    }

    public async FreshRegistry(): Promise<TenantAdminClientRegistry>
    {
        const registry = new TenantAdminClientRegistry(this.registryFile)
        await registry.Load()
        return registry
    }
}

/** Fixed TTL anchor + window used by the durable tests; the clock is driven relative to Start. */
class DurableTimes
{
    public static readonly Start = Date.parse('2026-01-01T00:00:00.000Z')
    public static readonly TtlMs = 168 * 60 * 60 * 1000
}

test('durable Begin reuses the secret within the TTL: one mint, RegisterClient on both, Complete works', async () =>
{
    await IdpFixture.With(async (conn, browser) =>
    {
        const fixture = await DurableFixture.Create()
        const clock = new Clock(DurableTimes.Start)
        const secrets: string[] = []
        const rp = new TenantOidcRelyingParty(
            new StubIdp(conn), await IdpFixture.Directory(), DurableFixture.RecordingFactory(secrets), IdpFixture.CallbackUrl,
            undefined, undefined, fixture.Durability(clock.Now, DurableTimes.TtlMs))

        const begin = await rp.Begin(IdpFixture.TenantId)
        const firstSecret = await fixture.StoredSecret(IdpFixture.TenantId)
        const firstRotatedAt = fixture.registry.Get(IdpFixture.TenantId)!.rotatedAt

        await rp.Begin(IdpFixture.TenantId)
        assert.equal(await fixture.StoredSecret(IdpFixture.TenantId), firstSecret)
        assert.equal(fixture.registry.Get(IdpFixture.TenantId)!.rotatedAt, firstRotatedAt)
        assert.equal(secrets.length, 2)
        assert.equal(secrets[0], secrets[1])

        await browser.Get(begin.Url)
        const redirect = await browser.PostForm(begin.Url, new Map([['email', IdpFixture.OwnerEmail], ['password', IdpFixture.OwnerPassword]]))
        const code = new URL(redirect.Location!).searchParams.get('code') ?? ''
        const result = await rp.Complete(IdpFixture.TenantId, code, begin.State)
        assert.equal(result.principalId, IdpFixture.OwnerPrincipalId)
    })
})

test('durable Begin rotates the secret after the TTL: new secret, rotatedAt advances', async () =>
{
    await IdpFixture.With(async (conn, _browser) =>
    {
        const fixture = await DurableFixture.Create()
        const clock = new Clock(DurableTimes.Start)
        const secrets: string[] = []
        const rp = new TenantOidcRelyingParty(
            new StubIdp(conn), await IdpFixture.Directory(), DurableFixture.RecordingFactory(secrets), IdpFixture.CallbackUrl,
            undefined, undefined, fixture.Durability(clock.Now, DurableTimes.TtlMs))

        await rp.Begin(IdpFixture.TenantId)
        const firstSecret = await fixture.StoredSecret(IdpFixture.TenantId)
        const firstRotatedAt = fixture.registry.Get(IdpFixture.TenantId)!.rotatedAt

        clock.Advance(DurableTimes.TtlMs + 1)
        await rp.Begin(IdpFixture.TenantId)
        const rotatedSecret = await fixture.StoredSecret(IdpFixture.TenantId)
        assert.notEqual(rotatedSecret, firstSecret)
        assert.notEqual(fixture.registry.Get(IdpFixture.TenantId)!.rotatedAt, firstRotatedAt)
    })
})

test('durable Begin rotates when rotatedAt is corrupted/unparseable, rather than freezing the secret', async () =>
{
    await IdpFixture.With(async (conn, _browser) =>
    {
        const fixture = await DurableFixture.Create()
        const clock = new Clock(DurableTimes.Start)
        const secrets: string[] = []
        const rp = new TenantOidcRelyingParty(
            new StubIdp(conn), await IdpFixture.Directory(), DurableFixture.RecordingFactory(secrets), IdpFixture.CallbackUrl,
            undefined, undefined, fixture.Durability(clock.Now, DurableTimes.TtlMs))

        await rp.Begin(IdpFixture.TenantId)
        const firstSecret = await fixture.StoredSecret(IdpFixture.TenantId)
        const record = fixture.registry.Get(IdpFixture.TenantId)!
        await fixture.registry.Put({ ...record, rotatedAt: 'not-a-date' })

        // The clock has NOT advanced past the TTL, so only the unparseable rotatedAt can force this rotation.
        await rp.Begin(IdpFixture.TenantId)
        assert.notEqual(await fixture.StoredSecret(IdpFixture.TenantId), firstSecret)
    })
})

test('durable secret persists across a fresh relying-party over the same store, key and registry', async () =>
{
    await IdpFixture.With(async (conn, _browser) =>
    {
        const fixture = await DurableFixture.Create()
        const clock = new Clock(DurableTimes.Start)
        const first = new TenantOidcRelyingParty(
            new StubIdp(conn), await IdpFixture.Directory(), DurableFixture.RecordingFactory([]), IdpFixture.CallbackUrl,
            undefined, undefined, fixture.Durability(clock.Now, DurableTimes.TtlMs))
        await first.Begin(IdpFixture.TenantId)
        const persisted = await fixture.StoredSecret(IdpFixture.TenantId)

        const reloaded = await fixture.FreshRegistry()
        const secondSecrets: string[] = []
        const second = new TenantOidcRelyingParty(
            new StubIdp(conn), await IdpFixture.Directory(), DurableFixture.RecordingFactory(secondSecrets), IdpFixture.CallbackUrl,
            undefined, undefined, fixture.DurabilityWith(reloaded, clock.Now, DurableTimes.TtlMs))
        await second.Begin(IdpFixture.TenantId)

        assert.equal(await fixture.StoredSecret(IdpFixture.TenantId), persisted)
        assert.equal(secondSecrets[0], persisted)
    })
})

test('durable Begin re-mints when a record exists but the stored secret is absent, never passing null to RegisterClient', async () =>
{
    await IdpFixture.With(async (conn, _browser) =>
    {
        const fixture = await DurableFixture.Create()
        const clock = new Clock(DurableTimes.Start)
        // A record is present but no secret was ever stored (e.g. the secret file was lost).
        await fixture.registry.Put({
            id: IdpFixture.TenantId,
            tenantId: IdpFixture.TenantId,
            clientId: TenantOidcRelyingParty.AdminClientId,
            secretRef: fixture.SecretRef(IdpFixture.TenantId),
            rotatedAt: new Date(DurableTimes.Start).toISOString()
        })
        assert.equal(await fixture.StoredSecret(IdpFixture.TenantId), null)

        const secrets: string[] = []
        const rp = new TenantOidcRelyingParty(
            new StubIdp(conn), await IdpFixture.Directory(), DurableFixture.RecordingFactory(secrets), IdpFixture.CallbackUrl,
            undefined, undefined, fixture.Durability(clock.Now, DurableTimes.TtlMs))
        await rp.Begin(IdpFixture.TenantId)

        const minted = await fixture.StoredSecret(IdpFixture.TenantId)
        assert.notEqual(minted, null)
        assert.equal(secrets.length, 1)
        assert.equal(secrets[0], minted)
    })
})

test('durable Begin that fails at RegisterClient throws TenantLoginError and leaks no secret', async () =>
{
    const fixture = await DurableFixture.Create()
    const clock = new Clock(DurableTimes.Start)
    const rp = new TenantOidcRelyingParty(
        new StubIdp(DurableFixture.DummyConn), await IdpFixture.Directory(), DurableFixture.ThrowingFactory(), IdpFixture.CallbackUrl,
        undefined, undefined, fixture.Durability(clock.Now, DurableTimes.TtlMs))

    await assert.rejects(
        () => rp.Begin(IdpFixture.TenantId),
        (err: unknown) =>
        {
            assert.ok(err instanceof TenantLoginError)
            assert.equal(err.message, DurableFixture.GenericLoginMessage)
            assert.ok(!/secret/i.test(err.message))
            return true
        })

    // The secret was minted (and persisted) before registration failed; it must leak into no record field.
    const minted = await fixture.StoredSecret(IdpFixture.TenantId)
    assert.notEqual(minted, null)
    const record = fixture.registry.Get(IdpFixture.TenantId)
    assert.ok(record !== undefined)
    assert.ok(!JSON.stringify(record).includes(minted!))
})

test('two concurrent first Begins for a fresh tenant mint and register exactly one secret', async () =>
{
    await IdpFixture.With(async (conn, _browser) =>
    {
        const fixture = await DurableFixture.Create()
        const clock = new Clock(DurableTimes.Start)
        const secrets: string[] = []
        const rp = new TenantOidcRelyingParty(
            new StubIdp(conn), await IdpFixture.Directory(), DurableFixture.RecordingFactory(secrets), IdpFixture.CallbackUrl,
            undefined, undefined, fixture.Durability(clock.Now, DurableTimes.TtlMs))

        await Promise.all([rp.Begin(IdpFixture.TenantId), rp.Begin(IdpFixture.TenantId)])
        assert.equal(secrets.length, 2)
        assert.equal(secrets[0], secrets[1])
        assert.equal(fixture.registry.List().length, 1)
        assert.equal(await fixture.StoredSecret(IdpFixture.TenantId), secrets[0])
    })
})

test('without durability each Begin mints a fresh secret (unchanged legacy behaviour)', async () =>
{
    await IdpFixture.With(async (conn, _browser) =>
    {
        const secrets: string[] = []
        const rp = new TenantOidcRelyingParty(new StubIdp(conn), await IdpFixture.Directory(), DurableFixture.RecordingFactory(secrets), IdpFixture.CallbackUrl)
        await rp.Begin(IdpFixture.TenantId)
        await rp.Begin(IdpFixture.TenantId)
        assert.equal(secrets.length, 2)
        assert.notEqual(secrets[0], secrets[1])
    })
})

test('Complete with a bad code throws a generic TenantLoginError that leaks neither the code nor a secret', async () =>
{
    await IdpFixture.With(async (conn, _browser) =>
    {
        const rp = new TenantOidcRelyingParty(new StubIdp(conn), await IdpFixture.Directory(), IdpFixture.AdminClientFor, IdpFixture.CallbackUrl)
        const begin = await rp.Begin(IdpFixture.TenantId)
        const badCode = 'this-is-not-a-real-authorization-code-0xDEADBEEF'
        await assert.rejects(
            () => rp.Complete(IdpFixture.TenantId, badCode, begin.State),
            (err: unknown) =>
            {
                assert.ok(err instanceof TenantLoginError)
                assert.equal(err.message, 'Tenant administrator login failed')
                assert.ok(!err.message.includes(badCode))
                assert.ok(!/secret/i.test(err.message))
                return true
            })
    })
})
