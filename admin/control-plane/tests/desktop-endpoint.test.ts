import { strict as assert } from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AppHost, AppHostConfig, OidcLoginError, OidcRelyingParty, RouteTable, SessionClaims, SessionStore, SignedInIdentity, type IOidcClientConfig } from '@pragmatic-tech-ai/pragmatic-app-host'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { type IEnvironmentService, EnvStatus, EnvType, Template, type EnvironmentRecord, type HiveRecord, type TenantRecord, TenantAdminCapabilities, type ITenantDirectory, TenantProfileMapper, DesktopAuthGate, DesktopEndpoint, DesktopSignInFlows, DesktopTargets, TenantOidcClientKind, TenantOidcClients, type ITenantOidcClients, TenantSessionGate, TenantSessionClaims, TenantSessionKind, TenantSessions } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { OidcClient } from '../../../src/idp/sql-idp-client-store.js'

type Reply = { status: number; body: Record<string, unknown> | undefined; text: string; headers: IncomingHttpHeaders }

/** The console's clients for the desktop: records the kind, tenant and callback of every client asked for. */
class FakeClients implements ITenantOidcClients
{
    public LastKind: TenantOidcClientKind | undefined
    public LastCallback: string | undefined
    public LastTenant: string | undefined

    public async ClientFor(_req: IncomingMessage): Promise<IOidcClientConfig>
    {
        throw new OidcLoginError()
    }

    public async For(kind: TenantOidcClientKind, tenantId: string, callbackUrl: string): Promise<IOidcClientConfig>
    {
        this.LastKind = kind
        this.LastTenant = tenantId
        this.LastCallback = callbackUrl
        return { Issuer: 'https://idp.example/acme', DiscoveryUrl: 'https://idp.example/acme/.well-known/openid-configuration', ClientId: 'pragmatic-desktop', RedirectUri: callbackUrl, ClientSecret: 's', FixedClaims: SessionClaims.From({ [TenantSessionClaims.TenantClaim]: tenantId }) }
    }
}

/** The app-host relying party with its exchange faked: each Begin hands out a fresh state; Complete answers a fixed subject. */
class FakeRelyingParty extends OidcRelyingParty
{
    public static readonly AuthorizeUrl = 'https://idp.example/acme/authorize'
    public static readonly PrincipalId = 'sub-1'
    public static readonly Email = 'ann@acme.test'
    public Fail = false
    public Begins = 0
    public Completions = 0
    public CompleteCallback: string | undefined
    private counter = 0

    public constructor()
    {
        super(new InMemoryOidcFlowStateStore())
    }

    public override async Begin(_client: IOidcClientConfig): Promise<{ Url: string; State: string }>
    {
        this.Begins++
        this.counter++
        const state = 'rp-state-' + String(this.counter) + '-0123456789abcdef'
        return { Url: FakeRelyingParty.AuthorizeUrl + '?state=' + state, State: state }
    }

    public override async Complete(client: IOidcClientConfig, _code: string, _state: string): Promise<SignedInIdentity>
    {
        this.Completions++
        this.CompleteCallback = client.RedirectUri
        if (this.Fail)
        {
            throw new OidcLoginError()
        }
        const claims = (client.FixedClaims ?? SessionClaims.Empty).With(TenantSessionClaims.EmailClaim, [FakeRelyingParty.Email])
        return new SignedInIdentity(FakeRelyingParty.PrincipalId, claims)
    }
}

class EndpointDirectory implements ITenantDirectory
{
    public GetTenant(id: string): TenantRecord | undefined
    {
        return id === EndpointKit.TenantId
            ? { id, clientId: 'c1', displayName: EndpointKit.TenantName, createdAt: '2026-01-01T00:00:00.000Z', ownerPrincipalId: FakeRelyingParty.PrincipalId }
            : undefined
    }

    public GetHive(): HiveRecord | undefined
    {
        return undefined
    }

    public ListHives(): readonly HiveRecord[]
    {
        return []
    }
}

class EndpointListing
{
    public async ListReconciled(): Promise<readonly EnvironmentRecord[]>
    {
        return [{ name: 'acme-dev', type: EnvType.Development, template: Template.DevBlank, environmentId: 'acme-dev', tenantId: EndpointKit.TenantId, createdAt: '2026-10-23T00:00:00.000Z', status: EnvStatus.Running }]
    }
}

class EndpointKit
{
    public static readonly TenantId = 'acme'
    public static readonly TenantName = 'Acme'
    public static readonly RedirectUri = 'http://127.0.0.1:53111/pragmatic-desktop/callback'
    public static readonly BeginPath = '/desktop/sign-in/begin'
    public static readonly CompletePath = '/desktop/sign-in/complete'
    public static readonly SignOutPath = '/desktop/sign-out'
    public static readonly ProfilePath = '/desktop/profile'
    public static readonly TargetsPath = '/desktop/targets'
    public static readonly ConsolePath = '/desktop/console'
    public static readonly Loopback = '127.0.0.1'
    public static readonly Code = 'auth-code-1'

    public static Verifier(): string
    {
        return randomBytes(32).toString('base64url')
    }

    public static Challenge(verifier: string): string
    {
        return createHash('sha256').update(verifier).digest('base64url')
    }
}

/** A movable millisecond clock for the throttles. */
class ThrottleClock
{
    private current = Date.now()

    public readonly Now = (): number => this.current

    public Advance(ms: number): void
    {
        this.current += ms
    }
}

/** The desktop endpoint registered on an AppHost of its own (public routes, the host's client address and body limit). */
class EndpointHarness
{
    public static readonly LockoutMs = 1000
    public readonly Rp = new FakeRelyingParty()
    public readonly Clients = new FakeClients()
    public readonly Clock = new ThrottleClock()
    public readonly Sessions = new TenantSessions(TenantSessions.InMemory(this.Clock.Now), false, { Login: { MaxAttempts: 3, LockoutMs: EndpointHarness.LockoutMs, Now: this.Clock.Now }, NowMs: this.Clock.Now })
    private readonly directory = new EndpointDirectory()
    public readonly DesktopGate = new DesktopAuthGate(this.Sessions.Store, this.directory)
    public readonly ConsoleGate = new TenantSessionGate(this.Sessions.Store, this.Sessions.Cookie, { TenantFor: () => EndpointKit.TenantId }, this.directory)
    public readonly Endpoint: DesktopEndpoint
    /** The sessions whose connections a sign-out asked to close (stands in for the relay). */
    public readonly ClosedSessions: string[] = []
    private readonly host: AppHost

    public constructor(trustedProxy: boolean = false, consoleTenantId?: string)
    {
        this.Endpoint = new DesktopEndpoint(
            { RelyingParty: this.Rp, Clients: this.Clients }, this.Sessions, this.DesktopGate, new DesktopSignInFlows(),
            new DesktopTargets(new EndpointListing() as unknown as IEnvironmentService), this.directory,
            s => TenantProfileMapper.ToDto(s, this.directory.GetTenant(s.tenantId), undefined, undefined, TenantAdminCapabilities.For(s)),
            { CloseSession: id => { this.ClosedSessions.push(id); return 1 } }, consoleTenantId)
        const table = new RouteTable()
        this.Endpoint.Register(table)
        this.host = new AppHost(new AppHostConfig({ TrustedProxy: trustedProxy }), { Routes: table })
    }

    public async Start(): Promise<void>
    {
        await this.host.Listen(0, EndpointKit.Loopback)
    }

    public async Dispose(): Promise<void>
    {
        await this.host.Close()
    }

    public Send(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply>
    {
        return this.SendRaw(method, path, body === undefined ? '' : JSON.stringify(body), headers)
    }

    public SendRaw(method: string, path: string, payload: string, headers: Record<string, string> = {}): Promise<Reply>
    {
        const port = this.host.Address().port
        return new Promise((resolve, reject) =>
        {
            const typed = payload.length === 0 ? headers : { 'content-type': 'application/json', ...headers }
            const req = request({ host: EndpointKit.Loopback, port, method, path, headers: typed }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () =>
                {
                    const text = Buffer.concat(chunks).toString('utf8')
                    resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? undefined : JSON.parse(text) as Record<string, unknown>, text, headers: res.headers })
                })
            })
            req.on('error', reject)
            req.end(payload)
        })
    }

    public Begin(redirectUri: string, challenge: string, headers: Record<string, string> = {}, tenantId: string = EndpointKit.TenantId): Promise<Reply>
    {
        return this.Send('POST', EndpointKit.BeginPath, { tenantId, redirectUri, bindingChallenge: challenge }, headers)
    }

    /** Begins a flow and returns its RP state (read from the authorize URL, as Plexus's loopback listener would). */
    public async BeginFlow(verifier: string): Promise<string>
    {
        const begun = await this.Begin(EndpointKit.RedirectUri, EndpointKit.Challenge(verifier))
        assert.equal(begun.status, 200)
        return new URL(begun.body!['authorizeUrl'] as string).searchParams.get('state') as string
    }

    public Complete(state: string, verifier: string, headers: Record<string, string> = {}): Promise<Reply>
    {
        return this.Send('POST', EndpointKit.CompletePath, { state, code: EndpointKit.Code, bindingVerifier: verifier }, headers)
    }

    public async SignIn(): Promise<string>
    {
        const verifier = EndpointKit.Verifier()
        const done = await this.Complete(await this.BeginFlow(verifier), verifier)
        assert.equal(done.status, 200)
        return done.body!['token'] as string
    }

    public Bearer(token: string): Record<string, string>
    {
        return { authorization: 'Bearer ' + token }
    }

    public RequestWith(headers: Record<string, string>): IncomingMessage
    {
        return { headers } as unknown as IncomingMessage
    }
}

describe('DesktopEndpoint', () =>
{
    let h: EndpointHarness

    beforeEach(async () =>
    {
        h = new EndpointHarness()
        await h.Start()
    })

    afterEach(async () =>
    {
        await h.Dispose()
    })

    it('begin answers the authorize URL and starts a Desktop-kind RP flow on the port-ful redirect', async () =>
    {
        const r = await h.Begin(EndpointKit.RedirectUri, EndpointKit.Challenge(EndpointKit.Verifier()))
        assert.equal(r.status, 200)
        assert.ok((r.body!['authorizeUrl'] as string).startsWith(FakeRelyingParty.AuthorizeUrl))
        assert.equal(h.Clients.LastKind, TenantOidcClientKind.Desktop)
        assert.equal(h.Clients.LastCallback, EndpointKit.RedirectUri)
    })

    it('begin rejects a non-loopback, port-0, port-80, wrong-path or zero-padded redirect, and a bad challenge', async () =>
    {
        const challenge = EndpointKit.Challenge(EndpointKit.Verifier())
        for (const bad of ['http://localhost:5/pragmatic-desktop/callback', 'http://127.0.0.1:0/pragmatic-desktop/callback', 'http://127.0.0.1:80/pragmatic-desktop/callback', 'http://127.0.0.1:5/other',
            'http://127.0.0.1:65536/pragmatic-desktop/callback', 'http://127.0.0.1:05/pragmatic-desktop/callback', 'https://127.0.0.1:5/pragmatic-desktop/callback'])
        {
            assert.equal((await h.Begin(bad, challenge)).status, 400, bad)
        }
        assert.equal((await h.Begin(EndpointKit.RedirectUri, 'too-short')).status, 400)
        assert.equal((await h.Begin(EndpointKit.RedirectUri, challenge.slice(0, 42) + '='))
            .status, 400)
        assert.equal(h.Rp.Begins, 0)
    })

    it('refuses any request carrying an Origin header with 403', async () =>
    {
        const r = await h.Begin(EndpointKit.RedirectUri, EndpointKit.Challenge(EndpointKit.Verifier()), { origin: 'http://evil.test' })
        assert.equal(r.status, 403)
        assert.equal(h.Rp.Begins, 0)
        const token = await h.SignIn()
        assert.equal((await h.Send('GET', EndpointKit.ProfilePath, undefined, { ...h.Bearer(token), origin: 'http://127.0.0.1:7002' })).status, 403)
    })

    it('begin for an unknown tenant is 404 unknown-tenant', async () =>
    {
        const r = await h.Begin(EndpointKit.RedirectUri, EndpointKit.Challenge(EndpointKit.Verifier()), {}, 'nope')
        assert.equal(r.status, 404)
        assert.deepEqual(r.body, { error: 'unknown-tenant' })
    })

    it('complete with a wrong verifier is 401 and the same state cannot be retried with the right one', async () =>
    {
        const verifier = EndpointKit.Verifier()
        const state = await h.BeginFlow(verifier)
        const wrong = await h.Complete(state, EndpointKit.Verifier())
        assert.equal(wrong.status, 401)
        assert.deepEqual(wrong.body, { error: 'sign-in-failed' })
        const retried = await h.Complete(state, verifier)
        assert.equal(retried.status, 401)
        assert.deepEqual(retried.body, { error: 'sign-in-failed' })
        assert.equal(h.Rp.Completions, 0)
    })

    it('complete succeeds with a desktop session that DesktopAuthGate accepts and the console gate rejects', async () =>
    {
        const verifier = EndpointKit.Verifier()
        const state = await h.BeginFlow(verifier)
        const done = await h.Complete(state, verifier)
        assert.equal(done.status, 200)
        const body = done.body!
        assert.equal(body['tenantId'], EndpointKit.TenantId)
        assert.equal(body['tenantName'], EndpointKit.TenantName)
        assert.equal(body['email'], FakeRelyingParty.Email)
        assert.ok(typeof body['expiresAt'] === 'string')
        assert.deepEqual(Object.keys(body).sort(), ['email', 'expiresAt', 'tenantId', 'tenantName', 'token'])
        assert.ok(!done.text.includes(verifier))
        assert.ok(!done.text.includes(state))
        assert.equal(h.Clients.LastKind, TenantOidcClientKind.Desktop)
        assert.equal(h.Rp.CompleteCallback, EndpointKit.RedirectUri)
        assert.equal(h.Clients.LastTenant, EndpointKit.TenantId)

        const token = body['token'] as string
        const desktop = await h.DesktopGate.Principal(h.RequestWith(h.Bearer(token)))
        assert.equal(desktop?.kind, TenantSessionKind.Desktop)
        assert.equal(desktop?.principalId, FakeRelyingParty.PrincipalId)
        const cookie = TenantSessions.CookieName + '=' + token
        assert.equal(await h.ConsoleGate.Current(h.RequestWith({ cookie })), null)
    })

    it('complete for an unknown state, or a failing RP, is 401 sign-in-failed', async () =>
    {
        assert.equal((await h.Complete('never-begun', EndpointKit.Verifier())).status, 401)
        h.Rp.Fail = true
        const verifier = EndpointKit.Verifier()
        const failed = await h.Complete(await h.BeginFlow(verifier), verifier)
        assert.equal(failed.status, 401)
        assert.deepEqual(failed.body, { error: 'sign-in-failed' })
    })

    it('repeated complete failures from one address are throttled with 429', async () =>
    {
        for (let i = 0; i < 3; i++)
        {
            assert.equal((await h.Complete('never-begun-' + String(i), EndpointKit.Verifier())).status, 401)
        }
        assert.equal((await h.Complete('never-begun-x', EndpointKit.Verifier())).status, 429)
    })

    it('sign-out revokes only that session', async () =>
    {
        const first = await h.SignIn()
        const second = await h.SignIn()
        assert.equal((await h.Send('POST', EndpointKit.SignOutPath, undefined, h.Bearer(first))).status, 204)
        assert.equal(await h.DesktopGate.Principal(h.RequestWith(h.Bearer(first))), null)
        assert.notEqual(await h.DesktopGate.Principal(h.RequestWith(h.Bearer(second))), null)
        assert.equal((await h.Send('GET', EndpointKit.ProfilePath, undefined, h.Bearer(first))).status, 401)
    })

    it('sign-out closes the connections (relays) opened under that session only', async () =>
    {
        const first = await h.SignIn()
        await h.SignIn()
        assert.equal((await h.Send('POST', EndpointKit.SignOutPath, undefined, h.Bearer(first))).status, 204)
        assert.deepEqual(h.ClosedSessions, [SessionStore.DigestOf(first)])
    })

    it('profile and targets answer for a desktop bearer', async () =>
    {
        const token = await h.SignIn()
        const profile = await h.Send('GET', EndpointKit.ProfilePath, undefined, h.Bearer(token))
        assert.equal(profile.status, 200)
        assert.equal(profile.body!['principalId'], FakeRelyingParty.PrincipalId)
        assert.equal(profile.body!['roleLabel'], TenantAdminCapabilities.AdminRoleLabel)
        assert.ok(!profile.text.includes(token))
        const targets = await h.Send('GET', EndpointKit.TargetsPath, undefined, h.Bearer(token))
        assert.equal(targets.status, 200)
        assert.deepEqual(targets.body, { contribute: [{ name: 'acme-dev', status: EnvStatus.Running }], publish: [] })
    })

    it('a missing, unknown or console bearer is 401 signed-out on the bearer routes', async () =>
    {
        const console = (await h.Sessions.Store.Issue(FakeRelyingParty.PrincipalId, TenantSessionClaims.Of(EndpointKit.TenantId, undefined))).Token
        const consoleTargets = await h.Send('GET', EndpointKit.TargetsPath, undefined, h.Bearer(console))
        assert.equal(consoleTargets.status, 401)
        assert.deepEqual(consoleTargets.body, { error: 'signed-out' })
        assert.equal((await h.Send('GET', EndpointKit.ProfilePath, undefined)).status, 401)
        assert.equal((await h.Send('GET', EndpointKit.ProfilePath, undefined, h.Bearer('unknown'))).status, 401)
        assert.equal((await h.Send('POST', EndpointKit.SignOutPath, undefined, h.Bearer(console))).status, 401)
        assert.notEqual(await h.Sessions.Store.Validate(console), null)
    })

    it('a wrong method is 405 with Allow and an unknown desktop path a JSON 404', async () =>
    {
        const wrong = await h.Send('GET', EndpointKit.BeginPath, undefined)
        assert.equal(wrong.status, 405)
        assert.equal(wrong.headers['allow'], 'POST')
        assert.equal((await h.Send('POST', EndpointKit.TargetsPath, undefined)).status, 405)
        const unknown = await h.Send('GET', '/desktop/other', undefined)
        assert.deepEqual([unknown.status, unknown.body], [404, { error: 'not-found' }])
    })

    it('a throttled complete does not burn the flow: once the lock lifts the same flow completes', async () =>
    {
        const verifier = EndpointKit.Verifier()
        const state = await h.BeginFlow(verifier)
        for (let i = 0; i < 3; i++)
        {
            assert.equal((await h.Complete('never-begun-' + String(i), EndpointKit.Verifier())).status, 401)
        }
        assert.equal((await h.Complete(state, verifier)).status, 429)
        h.Clock.Advance(EndpointHarness.LockoutMs + 1)
        assert.equal((await h.Complete(state, verifier)).status, 200)
    })

    it('begin is rate limited per address: the 11th begin in a minute is 429, whatever its body', async () =>
    {
        for (let i = 0; i < TenantSessions.MaxBeginsPerWindow; i++)
        {
            const body = i % 2 === 0 ? { tenantId: 'nope' } : { tenantId: EndpointKit.TenantId, redirectUri: EndpointKit.RedirectUri, bindingChallenge: EndpointKit.Challenge(EndpointKit.Verifier()) }
            assert.notEqual((await h.Send('POST', EndpointKit.BeginPath, body)).status, 429)
        }
        const limited = await h.Begin(EndpointKit.RedirectUri, EndpointKit.Challenge(EndpointKit.Verifier()))
        assert.equal(limited.status, 429)
        assert.deepEqual(limited.body, { error: 'too-many-requests' })
    })

    it('an oversized body is 413 and is not read further', async () =>
    {
        const huge = JSON.stringify({ tenantId: EndpointKit.TenantId, pad: 'x'.repeat(20000) })
        const r = await h.SendRaw('POST', EndpointKit.BeginPath, huge)
        assert.equal(r.status, 413)
        assert.equal(h.Rp.Begins, 0)
    })
})

/** Runs a body against a started harness (optionally behind a trusted proxy) and disposes it. */
class AddressKit
{
    public static readonly Forwarded = 'x-forwarded-for'

    public static async With(trustedProxy: boolean, body: (h: EndpointHarness) => Promise<void>): Promise<void>
    {
        await AddressKit.Run(new EndpointHarness(trustedProxy), body)
    }

    /** Runs a body against a started harness whose listener serves the console of `consoleTenantId`. */
    public static async WithConsole(consoleTenantId: string, body: (h: EndpointHarness) => Promise<void>): Promise<void>
    {
        await AddressKit.Run(new EndpointHarness(false, consoleTenantId), body)
    }

    private static async Run(h: EndpointHarness, body: (h: EndpointHarness) => Promise<void>): Promise<void>
    {
        await h.Start()
        try
        {
            await body(h)
        }
        finally
        {
            await h.Dispose()
        }
    }
}

describe('DesktopEndpoint console lookup', () =>
{
    it('names the served tenant', async () =>
    {
        await AddressKit.WithConsole(EndpointKit.TenantId, async h =>
        {
            const r = await h.Send('GET', EndpointKit.ConsolePath, undefined)
            assert.equal(r.status, 200)
            assert.deepEqual(r.body, { tenantId: EndpointKit.TenantId, tenantName: EndpointKit.TenantName })
            assert.equal(r.headers['cache-control'], 'no-store')
        })
    })

    it('is not a route without a served tenant (a JSON 404)', async () =>
    {
        await AddressKit.With(false, async h =>
        {
            assert.equal(h.Endpoint.Serves(EndpointKit.ConsolePath), false)
            assert.equal((await h.Send('GET', EndpointKit.ConsolePath, undefined)).status, 404)
        })
    })

    it('refuses an Origin with 403 and a POST with 405', async () =>
    {
        await AddressKit.WithConsole(EndpointKit.TenantId, async h =>
        {
            const forbidden = await h.Send('GET', EndpointKit.ConsolePath, undefined, { origin: 'https://evil.example' })
            assert.equal(forbidden.status, 403)
            assert.deepEqual(forbidden.body, { error: 'forbidden' })
            const post = await h.Send('POST', EndpointKit.ConsolePath, {})
            assert.equal(post.status, 405)
            assert.equal(post.headers['allow'], 'GET')
        })
    })

    it('shares the begin rate limit', async () =>
    {
        await AddressKit.WithConsole(EndpointKit.TenantId, async h =>
        {
            for (let i = 0; i < 6; i++)
            {
                assert.equal((await h.Send('GET', EndpointKit.ConsolePath, undefined)).status, 200, 'lookup ' + String(i))
            }
            for (let i = 0; i < 4; i++)
            {
                assert.equal((await h.Begin(EndpointKit.RedirectUri, EndpointKit.Challenge(EndpointKit.Verifier()))).status, 200, 'begin ' + String(i))
            }
            const limited = await h.Send('GET', EndpointKit.ConsolePath, undefined)
            assert.equal(limited.status, 429)
            assert.ok(limited.headers['retry-after'] !== undefined)
        })
    })

    it('for a served tenant the directory lost is 404 unknown-tenant', async () =>
    {
        await AddressKit.WithConsole('gone', async h =>
        {
            const r = await h.Send('GET', EndpointKit.ConsolePath, undefined)
            assert.equal(r.status, 404)
            assert.deepEqual(r.body, { error: 'unknown-tenant' })
        })
    })
})

describe('DesktopEndpoint client address', () =>
{
    it('behind a trusted proxy, two forwarded addresses get separate throttle buckets', async () =>
    {
        await AddressKit.With(true, async h =>
        {
            for (let i = 0; i < 3; i++)
            {
                assert.equal((await h.Complete('nope-' + String(i), EndpointKit.Verifier(), { [AddressKit.Forwarded]: '10.0.0.9, 203.0.113.1' })).status, 401)
            }
            assert.equal((await h.Complete('nope-x', EndpointKit.Verifier(), { [AddressKit.Forwarded]: '203.0.113.1' })).status, 429)
            assert.equal((await h.Complete('nope-y', EndpointKit.Verifier(), { [AddressKit.Forwarded]: '203.0.113.2' })).status, 401)
        })
    })

    it('without a trusted proxy the forwarded header is ignored (one bucket per socket address)', async () =>
    {
        await AddressKit.With(false, async h =>
        {
            for (let i = 0; i < 3; i++)
            {
                assert.equal((await h.Complete('nope-' + String(i), EndpointKit.Verifier(), { [AddressKit.Forwarded]: '203.0.113.1' })).status, 401)
            }
            assert.equal((await h.Complete('nope-y', EndpointKit.Verifier(), { [AddressKit.Forwarded]: '203.0.113.2' })).status, 429)
        })
    })
})

describe('DesktopEndpoint redirect rule agrees with the IdP loopback rule', () =>
{
    it('accepts exactly the redirects the IdP accepts for the registered desktop redirect', async () =>
    {
        const idp = new OidcClient('plexus-desktop', 'acme', [TenantOidcClients.DesktopRegisteredRedirect], [], 'unused-hash')
        const path = '/pragmatic-desktop/callback'
        const candidates = [1, 79, 80, 81, 443, 8080, 53111, 65535].map(port => 'http://127.0.0.1:' + String(port) + path)
            .concat(['http://127.0.0.1:080' + path, 'http://127.0.0.1:0' + path, 'http://127.0.0.1:65536' + path, 'http://127.0.0.1:05' + path,
                'http://localhost:5000' + path, 'http://127.0.0.1:5000/other', 'http://127.0.0.1:5000' + path + '?x=1'])
        for (const uri of candidates)
        {
            assert.equal(DesktopEndpoint.IsLoopbackRedirect(uri), idp.RedirectAllowed(uri), uri)
        }
        assert.equal(DesktopEndpoint.IsLoopbackRedirect('http://127.0.0.1:80' + path), false)
    })
})
