import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { RolloutFixture } from './rollout-fixture.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import type { IOperatorIdentity, OperatorPrincipal, OperatorSession } from '../operator-identity.js'
import { TenantSessionStore, type TenantSession } from '../tenant-auth/tenant-session.js'
import { TenantSessionCookie } from '../tenant-auth/tenant-session-cookie.js'
import { TenantAuthEndpoint } from '../tenant-auth/tenant-auth-endpoint.js'
import { TenantAuthGate } from '../tenant-auth/tenant-auth-gate.js'
import type { ITenantOidcRelyingParty } from '../tenant-auth/tenant-oidc-relying-party.js'
import type { ITenantApiEndpoint, TenantPlane } from '../tenant-auth/tenant-plane.js'
import { TenantEventBus } from '../tenant-api/tenant-events.js'

type Reply = { status: number; body: string }

enum HttpMethod
{
    Get = 'GET',
    Post = 'POST',
}

class FakeOperator implements IOperatorIdentity
{
    public static readonly Email = 'op@example.com'
    public static readonly Password = 'correct-horse'
    public static readonly Token = 'valid-token'

    public async Authenticate(email: string, password: string): Promise<OperatorSession | null>
    {
        return email === FakeOperator.Email && password === FakeOperator.Password
            ? { token: FakeOperator.Token, expiresAt: new Date(Date.now() + 3600000) }
            : null
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        return token === FakeOperator.Token ? { email: FakeOperator.Email, principalId: 'p1' } : null
    }

    public async Revoke(): Promise<void>
    {
    }
}

/** Minimal environment service: only ListReconciled is exercised by the operator route this suite probes. */
class StubEnvironments
{
    public async ListReconciled(): Promise<readonly never[]>
    {
        return []
    }

    public OnChanged(): () => void
    {
        return () => {}
    }
}

/** A stub tenant data API that answers every gated request 200, echoing the resolved tenant. */
class StubTenantApi implements ITenantApiEndpoint
{
    public Calls = 0
    private static readonly StatusOk = 200
    private static readonly ContentType = 'Content-Type'
    private static readonly JsonType = 'application/json; charset=utf-8'

    public async Handle(_req: IncomingMessage, res: ServerResponse, path: string, session: TenantSession): Promise<boolean>
    {
        this.Calls++
        res.writeHead(StubTenantApi.StatusOk, { [StubTenantApi.ContentType]: StubTenantApi.JsonType })
        res.end(JSON.stringify({ path, tenantId: session.tenantId }))
        return true
    }
}

/** The relying party is never invoked by the routes this suite drives; begin/complete are inert stubs. */
class StubRelyingParty implements ITenantOidcRelyingParty
{
    public async Begin(): Promise<{ Url: string; State: string }>
    {
        return { Url: 'https://idp.test/auth', State: 's' }
    }

    public async Complete(): Promise<{ principalId: string; email?: string }>
    {
        return { principalId: 'p' }
    }
}

class TenantHarness
{
    public static readonly TenantHost = 'tenant.local'
    public static readonly TenantId = 'acme'
    public static readonly OperatorCookie = 'cp_session=' + FakeOperator.Token
    public static readonly LocalHost = 'localhost'
    public static readonly TenantApiHivesPath = '/tenant-api/hives'
    public static readonly ApiHivesPath = '/api/hives'
    public static readonly ApiEnvironmentsPath = '/api/environments'
    public static readonly TenantAuthSessionPath = '/tenant-auth/session'
    public static readonly TenantAuthLogoutPath = '/tenant-auth/logout'
    public static readonly HostHeader = 'host'
    public static readonly CookieHeader = 'cookie'
    public static readonly OriginHeader = 'origin'
    public static readonly DisallowedOrigin = 'http://evil.example'
    public static readonly AllowedOrigin = 'http://tenant.local'
    private static readonly PairSeparator = '='
    private static readonly TenantTokenSeparator = '.'

    public static async BuildDirectory(parent: string): Promise<PlatformDirectory>
    {
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        return directory
    }

    public static PtsCookie(tenantId: string, token: string): string
    {
        return TenantSessionCookie.Name + TenantHarness.PairSeparator
            + encodeURIComponent(tenantId) + TenantHarness.TenantTokenSeparator + token
    }

    public static Raw(host: ControlPlaneHost, method: string, path: string, headers: Record<string, string>): Promise<Reply>
    {
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end()
        })
    }
}

describe('ControlPlaneHost tenant plane', () =>
{
    let parent: string
    let host: ControlPlaneHost
    let store: TenantSessionStore
    let api: StubTenantApi

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-tenant-'))
        const directory = await TenantHarness.BuildDirectory(parent)
        const factory = new HiveOrchestratorFactory()
        store = new TenantSessionStore(join(parent, 'tenant-sessions.json'), 3600000)
        api = new StubTenantApi()
        const endpoint = new TenantAuthEndpoint(new StubRelyingParty(), store, false)
        const plane: TenantPlane = {
            endpoint,
            gate: new TenantAuthGate(store),
            api,
            allowedHosts: new Set([TenantHarness.TenantHost]),
            events: new TenantEventBus(),
        }
        host = new ControlPlaneHost(
            new StubEnvironments() as unknown as IEnvironmentService,
            {} as unknown as IGraphService,
            join(parent, 'static'),
            new FakeOperator(),
            false,
            directory,
            factory,
            await RolloutFixture.Create(parent, directory, factory),
            new FakeProvisioning(directory).AsService(),
            plane)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('rejects /tenant-api with no tenant cookie as 401', async () =>
    {
        const r = await TenantHarness.Raw(host, HttpMethod.Get, TenantHarness.TenantApiHivesPath, { [TenantHarness.HostHeader]: TenantHarness.TenantHost })
        assert.equal(r.status, 401)
        assert.equal(JSON.parse(r.body).error, 'Authentication required')
        assert.equal(api.Calls, 0)
    })

    it('rejects /tenant-api when only an operator cookie is present as 401', async () =>
    {
        const r = await TenantHarness.Raw(host, HttpMethod.Get, TenantHarness.TenantApiHivesPath, { [TenantHarness.HostHeader]: TenantHarness.TenantHost, [TenantHarness.CookieHeader]: TenantHarness.OperatorCookie })
        assert.equal(r.status, 401)
        assert.equal(api.Calls, 0)
    })

    it('reaches the /tenant-auth endpoint without any gate', async () =>
    {
        const r = await TenantHarness.Raw(host, HttpMethod.Get, TenantHarness.TenantAuthSessionPath, { [TenantHarness.HostHeader]: TenantHarness.TenantHost })
        // The endpoint (not the gate, not static) answered: its own unauthorized body, distinct from the gate's message.
        assert.equal(r.status, 401)
        assert.equal(JSON.parse(r.body).error, 'unauthorized')
    })

    it('forbids a tenant host from reaching an operator /api route', async () =>
    {
        const r = await TenantHarness.Raw(host, HttpMethod.Get, TenantHarness.ApiHivesPath, { [TenantHarness.HostHeader]: TenantHarness.TenantHost })
        assert.equal(r.status, 403)
        assert.equal(JSON.parse(r.body).error, 'Host not allowed')
    })

    it('still requires the operator cookie on /api from an operator host', async () =>
    {
        const r = await TenantHarness.Raw(host, HttpMethod.Get, TenantHarness.ApiHivesPath, { [TenantHarness.HostHeader]: TenantHarness.LocalHost })
        assert.equal(r.status, 401)
    })

    it('passes a valid /tenant-api request through the gate to the api', async () =>
    {
        const issued = await store.Issue(TenantHarness.TenantId, 'u1')
        const r = await TenantHarness.Raw(host, HttpMethod.Get, TenantHarness.TenantApiHivesPath, {
            [TenantHarness.HostHeader]: TenantHarness.TenantHost,
            [TenantHarness.CookieHeader]: TenantHarness.PtsCookie(TenantHarness.TenantId, issued.id),
        })
        assert.equal(r.status, 200)
        assert.equal(api.Calls, 1)
        assert.equal(JSON.parse(r.body).tenantId, TenantHarness.TenantId)
    })

    it('rejects a mutating /tenant-auth request with a disallowed Origin as 403', async () =>
    {
        const r = await TenantHarness.Raw(host, HttpMethod.Post, TenantHarness.TenantAuthLogoutPath, {
            [TenantHarness.HostHeader]: TenantHarness.TenantHost,
            [TenantHarness.OriginHeader]: TenantHarness.DisallowedOrigin,
        })
        assert.equal(r.status, 403)
        assert.equal(JSON.parse(r.body).error, 'Origin not allowed')
    })

    it('allows a mutating /tenant-auth request with an allowed Origin', async () =>
    {
        const r = await TenantHarness.Raw(host, HttpMethod.Post, TenantHarness.TenantAuthLogoutPath, {
            [TenantHarness.HostHeader]: TenantHarness.TenantHost,
            [TenantHarness.OriginHeader]: TenantHarness.AllowedOrigin,
        })
        // The logout endpoint cleared the (absent) session: 204, i.e. it passed the CSRF gate and reached the endpoint.
        assert.equal(r.status, 204)
    })

    it('allows a mutating /tenant-auth request with no Origin', async () =>
    {
        const r = await TenantHarness.Raw(host, HttpMethod.Post, TenantHarness.TenantAuthLogoutPath, { [TenantHarness.HostHeader]: TenantHarness.TenantHost })
        assert.equal(r.status, 204)
    })
})

describe('ControlPlaneHost without a tenant plane', () =>
{
    let parent: string
    let host: ControlPlaneHost

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-notenant-'))
        const directory = await TenantHarness.BuildDirectory(parent)
        const factory = new HiveOrchestratorFactory()
        host = new ControlPlaneHost(
            new StubEnvironments() as unknown as IEnvironmentService,
            {} as unknown as IGraphService,
            join(parent, 'static'),
            new FakeOperator(),
            false,
            directory,
            factory,
            await RolloutFixture.Create(parent, directory, factory),
            new FakeProvisioning(directory).AsService())
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('answers an operator route 401 without a cookie and 200 with one', async () =>
    {
        const anon = await TenantHarness.Raw(host, HttpMethod.Get, TenantHarness.ApiEnvironmentsPath, { [TenantHarness.HostHeader]: TenantHarness.LocalHost })
        assert.equal(anon.status, 401)
        const authed = await TenantHarness.Raw(host, HttpMethod.Get, TenantHarness.ApiEnvironmentsPath, { [TenantHarness.HostHeader]: TenantHarness.LocalHost, [TenantHarness.CookieHeader]: TenantHarness.OperatorCookie })
        assert.equal(authed.status, 200)
    })

    it('does not route /tenant-api when no tenant plane is configured', async () =>
    {
        const r = await TenantHarness.Raw(host, HttpMethod.Get, TenantHarness.TenantApiHivesPath, { [TenantHarness.HostHeader]: TenantHarness.LocalHost })
        assert.equal(r.status, 404)
    })
})
