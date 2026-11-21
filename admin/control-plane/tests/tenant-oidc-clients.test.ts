import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OidcRelyingParty } from '@pragmatic-tech-ai/pragmatic-app-host'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { PgSession, type SqlSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity'
import { TenantIdpTestHost } from '../../../src/idp/tests/tenant-idp-test-host.js'
import { IdpAdminClient, type IdpAdminClientOptions, type IdpAdminClientRegistration, type IIdpService, type EnvironmentRecord, TenantAdminClientRegistry, TenantOidcClientKind, TenantOidcClients, UnknownTenantHostError, type ITenantCallbacks, type TenantOidcClientSecrets, TenantSessionClaims } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { IdpConnection } from '../idp-service.js'
import { PlatformDirectory, type IEnvironmentLookup } from '../platform-directory.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { TenantAdminDatabase, TenantAdminRegistry } from '../tenant-admin-database.js'

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
    private static readonly JsonContentType = 'application/json'
    private static readonly PasswordMethod = 'password'
    private static readonly StatusOk = 200
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

    /** What the login page does: posts the credentials with the authorize request to the realm's login API; the
     *  answer's `redirect` is where the browser goes next. */
    public async Login(authorizeUrl: string, email: string, password: string): Promise<BrowserResponse>
    {
        const url = new URL(authorizeUrl)
        const issuer = url.origin + url.pathname.slice(0, -RealmIssuer.AuthorizePath.length)
        const body = JSON.stringify({ request: url.search.slice(1), method: Browser.PasswordMethod, email, password })
        const reply = await this.send(Browser.PostMethod, issuer + RealmIssuer.LoginPath, body)
        const redirect = reply.Status === Browser.StatusOk ? (JSON.parse(reply.Body) as { redirect: string }).redirect : undefined
        return new BrowserResponse(reply.Status, redirect, reply.Body)
    }

    private send(method: string, url: string, body: string | undefined): Promise<BrowserResponse>
    {
        const headers: Record<string, string> = {}
        if (body !== undefined)
        {
            headers[Browser.ContentTypeHeader] = Browser.JsonContentType
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

    public async ConnectForTenant(_tenantId: string): Promise<IdpConnection | undefined>
    {
        return undefined
    }

    public async TeardownForTenant(_tenantId: string): Promise<void>
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
    public static readonly AdminToken = TenantIdpTestHost.AdminToken
    public static readonly OwnerEmail = 'owner@acme.test'
    public static readonly OwnerPrincipalId = 'user-owner-0001'
    public static readonly OwnerPassword = 'correct-horse-battery-staple'
    public static readonly OwnerDisplayName = 'Acme Owner'
    public static readonly CallbackUrl = 'https://admin.acme.test/tenant-auth/oidc/callback'
    public static readonly OverrideCallbackUrl = 'https://acme.admin.example.com/tenant-auth/oidc/callback'
    public static readonly SecondTenantId = 'beta'
    public static readonly SecondTenantName = 'Beta'
    public static readonly SecondCallbackUrl = 'https://beta.admin.example.com/tenant-auth/oidc/callback'
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
        const host = await TenantIdpTestHost.Start()
        try
        {
            const ca = Buffer.from(host.Ca)
            const conn: IdpConnection = { baseUrl: host.BaseUrl, browserBaseUrl: host.BaseUrl, ca, adminToken: IdpFixture.AdminToken, adminTokenRef: 'admin-token', caDir: '/data/idp/tls' }
            const client = new IdpAdminClient({ baseUrl: host.BaseUrl, adminToken: IdpFixture.AdminToken, ca })
            await client.EnsureRealm(IdpFixture.TenantId, 'Acme')
            await client.SeedAccount(IdpFixture.TenantId, { email: IdpFixture.OwnerEmail, principalId: IdpFixture.OwnerPrincipalId, displayName: IdpFixture.OwnerDisplayName, password: IdpFixture.OwnerPassword })
            await body(conn, new Browser(ca))
        }
        finally
        {
            await host.Close()
        }
    }
}

/** A real IdpAdminClient that records every registration before delegating upstream. */
class RecordingAdminClient extends IdpAdminClient
{
    public constructor(options: IdpAdminClientOptions, private readonly sink: IdpAdminClientRegistration[])
    {
        super(options)
    }

    public override async RegisterClient(tenantId: string, client: IdpAdminClientRegistration): Promise<void>
    {
        this.sink.push(client)
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

/** An injectable, movable clock. */
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

/** The provider's durable parts over pg-mem (the production stores: SqlSecretStore + a SQL record map). */
class Durable
{
    public static readonly Start = Date.parse('2026-01-01T00:00:00.000Z')
    public static readonly TtlMs = 168 * 60 * 60 * 1000
    public static readonly ConsoleRef = 'tenant-admin-oidc/acme'
    public static readonly DesktopRef = 'tenant-desktop-oidc/acme'

    private constructor(public readonly Store: SqlSecretStore, public readonly Registry: TenantAdminClientRegistry, public readonly Clock: Clock)
    {
    }

    public static async Create(): Promise<Durable>
    {
        const session = new PgSession(SqlTestSessions.MemPool())
        const database = TenantAdminDatabase.Over(session)
        const registry = new TenantAdminClientRegistry(await database.Map(TenantAdminRegistry.TenantAdminClients))
        await registry.Load()
        return new Durable(await database.Secrets(randomBytes(32)), registry, new Clock(Durable.Start))
    }

    public Secrets(): TenantOidcClientSecrets
    {
        return { Store: this.Store, Registry: this.Registry, TtlMs: Durable.TtlMs, Now: this.Clock.Now }
    }
}

/** The hosts of the console's tenant: acme on admin.acme.test, with the console callback on that host. */
class Hosts implements ITenantCallbacks
{
    public static readonly AcmeHost = 'acme.admin.example.com'

    public TenantFor(hostHeader: string | undefined): string | undefined
    {
        return hostHeader === Hosts.AcmeHost ? IdpFixture.TenantId : undefined
    }

    public CallbackFor(_hostHeader: string): string
    {
        return IdpFixture.OverrideCallbackUrl
    }
}

class Factories
{
    public static Recording(sink: IdpAdminClientRegistration[]): (conn: IdpConnection) => IdpAdminClient
    {
        return conn => new RecordingAdminClient({ baseUrl: conn.baseUrl, adminToken: conn.adminToken, ca: conn.ca }, sink)
    }

    public static Throwing(): (conn: IdpConnection) => IdpAdminClient
    {
        return conn => new ThrowingAdminClient({ baseUrl: conn.baseUrl, adminToken: conn.adminToken, ca: conn.ca })
    }
}

describe('TenantOidcClients over the real tenant IdP', () =>
{
    it('the console client: the browser-facing issuer, the console client id, the callback, a confidential secret, the tenant as a fixed claim', async () =>
    {
        await IdpFixture.With(async conn =>
        {
            const durable = await Durable.Create()
            const clients = new TenantOidcClients(new StubIdp(conn), await IdpFixture.Directory(), IdpFixture.AdminClientFor, new Hosts(), durable.Secrets())
            const client = await clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl)
            assert.equal(client.Issuer, conn.browserBaseUrl + '/realms/' + IdpFixture.TenantId)
            assert.equal(client.DiscoveryUrl, conn.baseUrl + '/realms/' + IdpFixture.TenantId + '/.well-known/openid-configuration')
            assert.equal(client.ClientId, TenantOidcClients.ConsoleClientId)
            assert.equal(client.RedirectUri, IdpFixture.CallbackUrl)
            assert.equal(client.ClientSecret, await durable.Store.Get(Durable.ConsoleRef))
            assert.equal(client.Application, TenantOidcClients.Application)
            assert.deepEqual(client.FixedClaims?.ToJson(), { [TenantSessionClaims.TenantClaim]: [IdpFixture.TenantId] })
        })
    })

    it('a full sign-in: Begin at the IdP, the real login page, Complete to the seeded owner with the tenant claim', async () =>
    {
        await IdpFixture.With(async (conn, browser) =>
        {
            const durable = await Durable.Create()
            const clients = new TenantOidcClients(new StubIdp(conn), await IdpFixture.Directory(), IdpFixture.AdminClientFor, new Hosts(), durable.Secrets())
            const rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore())
            const client = await clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl)
            const begin = await rp.Begin(client)
            const url = new URL(begin.Url)
            assert.equal(url.origin, new URL(conn.baseUrl).origin)
            assert.equal(url.searchParams.get('client_id'), TenantOidcClients.ConsoleClientId)
            assert.equal(url.searchParams.get('redirect_uri'), IdpFixture.CallbackUrl)
            assert.ok((url.searchParams.get('code_challenge') ?? '').length > 0)
            const redirect = await browser.Login(begin.Url, IdpFixture.OwnerEmail, IdpFixture.OwnerPassword)
            assert.equal(redirect.Status, 200)
            const target = new URL(redirect.Location as string)
            assert.equal(target.origin + target.pathname, IdpFixture.CallbackUrl)
            const who = await rp.Complete(await clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl), target.searchParams.get('code') as string, begin.State)
            assert.equal(who.Subject, IdpFixture.OwnerPrincipalId)
            assert.equal(who.Claims.First(TenantSessionClaims.EmailClaim), IdpFixture.OwnerEmail)
            assert.equal(who.Claims.First(TenantSessionClaims.TenantClaim), IdpFixture.TenantId)
        })
    })

    it('ClientFor resolves the tenant and its callback from the request host; an unknown host is refused', async () =>
    {
        await IdpFixture.With(async conn =>
        {
            const durable = await Durable.Create()
            const clients = new TenantOidcClients(new StubIdp(conn), await IdpFixture.Directory(), IdpFixture.AdminClientFor, new Hosts(), durable.Secrets())
            const client = await clients.ClientFor({ headers: { host: Hosts.AcmeHost } } as unknown as IncomingMessage)
            assert.equal(client.RedirectUri, IdpFixture.OverrideCallbackUrl)
            assert.equal(client.FixedClaims?.First(TenantSessionClaims.TenantClaim), IdpFixture.TenantId)
            await assert.rejects(clients.ClientFor({ headers: { host: 'other.example.com' } } as unknown as IncomingMessage), UnknownTenantHostError)
        })
    })

    it('within the TTL the stored secret is reused and registered once per process; after it the secret rotates and is registered again', async () =>
    {
        await IdpFixture.With(async conn =>
        {
            const durable = await Durable.Create()
            const registrations: IdpAdminClientRegistration[] = []
            const clients = new TenantOidcClients(new StubIdp(conn), await IdpFixture.Directory(), Factories.Recording(registrations), new Hosts(), durable.Secrets())
            const first = await clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl)
            const again = await clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl)
            assert.equal(again.ClientSecret, first.ClientSecret)
            assert.equal(registrations.length, 1)
            const rotatedAt = durable.Registry.Get(IdpFixture.TenantId)?.rotatedAt
            durable.Clock.Advance(Durable.TtlMs + 1)
            const rotated = await clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl)
            assert.notEqual(rotated.ClientSecret, first.ClientSecret)
            assert.equal(registrations.length, 2)
            assert.equal(registrations[1]?.secret, rotated.ClientSecret)
            assert.notEqual(durable.Registry.Get(IdpFixture.TenantId)?.rotatedAt, rotatedAt)
        })
    })

    it('a fresh process over the same stores reuses the secret and registers it once more', async () =>
    {
        await IdpFixture.With(async conn =>
        {
            const durable = await Durable.Create()
            const registrations: IdpAdminClientRegistration[] = []
            const before = await new TenantOidcClients(new StubIdp(conn), await IdpFixture.Directory(), Factories.Recording(registrations), new Hosts(), durable.Secrets())
                .For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl)
            const after = await new TenantOidcClients(new StubIdp(conn), await IdpFixture.Directory(), Factories.Recording(registrations), new Hosts(), durable.Secrets())
                .For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl)
            assert.equal(after.ClientSecret, before.ClientSecret)
            assert.equal(registrations.length, 2)
        })
    })

    it('a record whose stored secret is missing (an imported console) mints and registers a fresh one', async () =>
    {
        await IdpFixture.With(async conn =>
        {
            const durable = await Durable.Create()
            await durable.Registry.Put({ id: IdpFixture.TenantId, tenantId: IdpFixture.TenantId, clientId: TenantOidcClients.ConsoleClientId, secretRef: Durable.ConsoleRef, rotatedAt: new Date(Durable.Start).toISOString() })
            const registrations: IdpAdminClientRegistration[] = []
            const client = await new TenantOidcClients(new StubIdp(conn), await IdpFixture.Directory(), Factories.Recording(registrations), new Hosts(), durable.Secrets())
                .For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl)
            assert.ok((client.ClientSecret ?? '').length > 0)
            assert.equal(registrations[0]?.secret, client.ClientSecret)
        })
    })

    it('a corrupt rotatedAt counts as aged (rotates rather than freezing the secret)', async () =>
    {
        await IdpFixture.With(async conn =>
        {
            const durable = await Durable.Create()
            const clients = new TenantOidcClients(new StubIdp(conn), await IdpFixture.Directory(), IdpFixture.AdminClientFor, new Hosts(), durable.Secrets())
            const first = await clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl)
            const record = durable.Registry.Get(IdpFixture.TenantId)
            await durable.Registry.Put({ ...record!, rotatedAt: 'not a time' })
            const second = await clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl)
            assert.notEqual(second.ClientSecret, first.ClientSecret)
        })
    })

    it('two concurrent first calls for one client mint and register exactly one secret', async () =>
    {
        await IdpFixture.With(async conn =>
        {
            const durable = await Durable.Create()
            const registrations: IdpAdminClientRegistration[] = []
            const clients = new TenantOidcClients(new StubIdp(conn), await IdpFixture.Directory(), Factories.Recording(registrations), new Hosts(), durable.Secrets())
            const [a, b] = await Promise.all([
                clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl),
                clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl),
            ])
            assert.equal(a.ClientSecret, b.ClientSecret)
            assert.equal(new Set(registrations.map(r => r.secret)).size, 1)
        })
    })

    it('the desktop client has its own id, secret and row, registers the portless loopback redirect and carries the port-ful callback', async () =>
    {
        await IdpFixture.With(async conn =>
        {
            const durable = await Durable.Create()
            const registrations: IdpAdminClientRegistration[] = []
            const clients = new TenantOidcClients(new StubIdp(conn), await IdpFixture.Directory(), Factories.Recording(registrations), new Hosts(), durable.Secrets())
            const callback = 'http://127.0.0.1:51234/pragmatic-desktop/callback'
            const desktop = await clients.For(TenantOidcClientKind.Desktop, IdpFixture.TenantId, callback)
            const console = await clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl)
            assert.equal(desktop.RedirectUri, callback)
            assert.notEqual(desktop.ClientId, console.ClientId)
            assert.notEqual(desktop.ClientSecret, console.ClientSecret)
            assert.deepEqual(registrations[0]?.redirectUris, [TenantOidcClients.DesktopRegisteredRedirect])
            assert.equal(await durable.Store.Get(Durable.DesktopRef), desktop.ClientSecret)
            assert.ok(durable.Registry.Get(Durable.DesktopRef) !== undefined)
            const begin = await new OidcRelyingParty(new InMemoryOidcFlowStateStore()).Begin(desktop)
            assert.equal(new URL(begin.Url).searchParams.get('redirect_uri'), callback)
        })
    })

    it('a failed registration at the IdP rejects without the secret in the error', async () =>
    {
        await IdpFixture.With(async conn =>
        {
            const durable = await Durable.Create()
            const clients = new TenantOidcClients(new StubIdp(conn), await IdpFixture.Directory(), Factories.Throwing(), new Hosts(), durable.Secrets())
            const failure = await clients.For(TenantOidcClientKind.Console, IdpFixture.TenantId, IdpFixture.CallbackUrl).then(() => undefined, (err: unknown) => err as Error)
            assert.ok(failure instanceof Error)
            const secret = await durable.Store.Get(Durable.ConsoleRef)
            assert.ok(secret !== null && !failure.message.includes(secret))
        })
    })
})
