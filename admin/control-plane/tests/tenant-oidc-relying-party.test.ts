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
import { IdpAdminClient } from '../idp-admin-client.js'
import type { IdpConnection, IIdpService } from '../idp-service.js'
import { PlatformDirectory } from '../platform-directory.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import type { EnvironmentRecord } from '../environment-record.js'
import type { IEnvironmentLookup } from '../platform-directory.js'
import { TenantLoginError, TenantOidcRelyingParty } from '../tenant-auth/tenant-oidc-relying-party.js'

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
