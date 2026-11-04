import { strict as assert } from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { IEnvironmentService } from '../control-plane-host.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { LoginThrottle } from '../login-throttle.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import { TenantAdminCapabilities } from '../tenant-api/tenant-admin-capabilities.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { TenantProfileMapper } from '../tenant-api/tenant-profile-dto.js'
import { DesktopAuthGate } from '../tenant-auth/desktop-auth-gate.js'
import { DesktopEndpoint } from '../tenant-auth/desktop-endpoint.js'
import { DesktopSignInFlows } from '../tenant-auth/desktop-sign-in-flows.js'
import { DesktopTargets } from '../tenant-auth/desktop-targets.js'
import { TenantAuthGate } from '../tenant-auth/tenant-auth-gate.js'
import { TenantLoginError, TenantOidcClientKind, type ITenantOidcRelyingParty } from '../tenant-auth/tenant-oidc-relying-party.js'
import { TenantSessionCookie } from '../tenant-auth/tenant-session-cookie.js'
import { TenantSessionKind, TenantSessionStore } from '../tenant-auth/tenant-session.js'

type Reply = { status: number; body: Record<string, unknown> | undefined; text: string }

/** Records what the endpoint passes and answers a fixed principal; each Begin hands out a fresh RP state. */
class FakeRelyingParty implements ITenantOidcRelyingParty
{
    public static readonly AuthorizeUrl = 'https://idp.example/acme/authorize'
    public static readonly PrincipalId = 'sub-1'
    public static readonly Email = 'ann@acme.test'
    public Fail = false
    public BeginKind: TenantOidcClientKind | undefined
    public BeginCallback: string | undefined
    public CompleteKind: TenantOidcClientKind | undefined
    public CompleteCallback: string | undefined
    public CompleteTenant: string | undefined
    public Completions = 0
    private counter = 0

    public async Begin(_tenantId: string, callbackUrl: string, kind: TenantOidcClientKind = TenantOidcClientKind.Console): Promise<{ Url: string; State: string }>
    {
        this.BeginKind = kind
        this.BeginCallback = callbackUrl
        this.counter++
        const state = 'rp-state-' + String(this.counter) + '-0123456789abcdef'
        return { Url: FakeRelyingParty.AuthorizeUrl + '?state=' + state, State: state }
    }

    public async Complete(tenantId: string, _code: string, _state: string, callbackUrl: string, kind: TenantOidcClientKind = TenantOidcClientKind.Console): Promise<{ principalId: string; email?: string }>
    {
        this.Completions++
        this.CompleteTenant = tenantId
        this.CompleteKind = kind
        this.CompleteCallback = callbackUrl
        if (this.Fail)
        {
            throw new TenantLoginError()
        }
        return { principalId: FakeRelyingParty.PrincipalId, email: FakeRelyingParty.Email }
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

/** A movable millisecond clock for the login throttle. */
class ThrottleClock
{
    private current = Date.now()

    public readonly Now = (): number => this.current

    public Advance(ms: number): void
    {
        this.current += ms
    }
}

class EndpointHarness
{
    public static readonly LockoutMs = 1000
    public readonly Dir = mkdtempSync(join(tmpdir(), 'desktop-endpoint-'))
    public readonly Rp = new FakeRelyingParty()
    public readonly Sessions = new TenantSessionStore(join(this.Dir, 'sessions.json'), 3600000)
    public readonly DesktopGate = new DesktopAuthGate(this.Sessions)
    public readonly ConsoleGate = new TenantAuthGate(this.Sessions)
    public readonly Clock = new ThrottleClock()
    public readonly Throttle = new LoginThrottle({ maxAttempts: 3, lockoutMs: EndpointHarness.LockoutMs, now: this.Clock.Now })
    private readonly directory = new EndpointDirectory()
    public readonly Endpoint: DesktopEndpoint
    /** The sessions whose connections a sign-out asked to close (stands in for the relay). */
    public readonly ClosedSessions: string[] = []
    private server: Server | undefined

    public constructor(trustedProxy: boolean = false)
    {
        this.Endpoint = new DesktopEndpoint(
            this.Rp, this.Sessions, this.DesktopGate, new DesktopSignInFlows(),
            new DesktopTargets(new EndpointListing() as unknown as IEnvironmentService, this.directory), this.directory,
            s => TenantProfileMapper.ToDto(s, this.directory.GetTenant(s.tenantId), undefined, undefined, TenantAdminCapabilities.For(s, this.directory.GetTenant(s.tenantId))),
            this.Throttle, DesktopEndpoint.NewBeginThrottle(), trustedProxy,
            { CloseSession: id => { this.ClosedSessions.push(id); return 1 } })
    }

    public async Start(): Promise<void>
    {
        this.server = createServer((req, res) =>
        {
            const path = new URL(req.url ?? '/', 'http://localhost').pathname
            void this.Endpoint.Handle(req, res, path).then(handled =>
            {
                if (!handled)
                {
                    res.writeHead(404)
                    res.end()
                }
            }, () =>
            {
                res.writeHead(500)
                res.end()
            })
        })
        await new Promise<void>(r => this.server!.listen(0, EndpointKit.Loopback, () => r()))
    }

    public async Dispose(): Promise<void>
    {
        await new Promise<void>(r => this.server === undefined ? r() : this.server.close(() => r()))
        rmSync(this.Dir, { recursive: true, force: true })
    }

    public Send(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply>
    {
        return this.SendRaw(method, path, body === undefined ? '' : JSON.stringify(body), headers)
    }

    public SendRaw(method: string, path: string, payload: string, headers: Record<string, string> = {}): Promise<Reply>
    {
        const port = (this.server!.address() as AddressInfo).port
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: EndpointKit.Loopback, port, method, path, headers: { 'content-type': 'application/json', ...headers } }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () =>
                {
                    const text = Buffer.concat(chunks).toString('utf8')
                    resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? undefined : JSON.parse(text) as Record<string, unknown>, text })
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
        assert.equal(h.Rp.BeginKind, TenantOidcClientKind.Desktop)
        assert.equal(h.Rp.BeginCallback, EndpointKit.RedirectUri)
    })

    it('begin rejects a non-loopback, port-0, wrong-path or zero-padded redirect, and a bad challenge', async () =>
    {
        const challenge = EndpointKit.Challenge(EndpointKit.Verifier())
        for (const bad of ['http://localhost:5/pragmatic-desktop/callback', 'http://127.0.0.1:0/pragmatic-desktop/callback', 'http://127.0.0.1:5/other',
            'http://127.0.0.1:65536/pragmatic-desktop/callback', 'http://127.0.0.1:05/pragmatic-desktop/callback', 'https://127.0.0.1:5/pragmatic-desktop/callback'])
        {
            assert.equal((await h.Begin(bad, challenge)).status, 400, bad)
        }
        assert.equal((await h.Begin(EndpointKit.RedirectUri, 'too-short')).status, 400)
        assert.equal((await h.Begin(EndpointKit.RedirectUri, challenge.slice(0, 42) + '='))
            .status, 400)
        assert.equal(h.Rp.BeginKind, undefined)
    })

    it('refuses any request carrying an Origin header with 403', async () =>
    {
        const r = await h.Begin(EndpointKit.RedirectUri, EndpointKit.Challenge(EndpointKit.Verifier()), { origin: 'http://evil.test' })
        assert.equal(r.status, 403)
        assert.equal(h.Rp.BeginKind, undefined)
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

    it('complete succeeds with a Desktop session that DesktopAuthGate accepts and TenantAuthGate rejects', async () =>
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
        assert.equal(h.Rp.CompleteKind, TenantOidcClientKind.Desktop)
        assert.equal(h.Rp.CompleteCallback, EndpointKit.RedirectUri)
        assert.equal(h.Rp.CompleteTenant, EndpointKit.TenantId)

        const token = body['token'] as string
        const desktop = await h.DesktopGate.Principal(h.RequestWith(h.Bearer(token)))
        assert.equal(desktop?.kind, TenantSessionKind.Desktop)
        assert.equal(desktop?.principalId, FakeRelyingParty.PrincipalId)
        const cookie = TenantSessionCookie.Name + '=' + EndpointKit.TenantId + '.' + token
        assert.equal(await h.ConsoleGate.Principal(h.RequestWith({ cookie })), null)
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
        assert.deepEqual(h.ClosedSessions, [first])
    })

    it('profile and targets answer for a desktop bearer', async () =>
    {
        const token = await h.SignIn()
        const profile = await h.Send('GET', EndpointKit.ProfilePath, undefined, h.Bearer(token))
        assert.equal(profile.status, 200)
        assert.equal(profile.body!['principalId'], FakeRelyingParty.PrincipalId)
        assert.equal(profile.body!['roleLabel'], TenantAdminCapabilities.OwnerRoleLabel)
        assert.ok(!profile.text.includes(token))
        const targets = await h.Send('GET', EndpointKit.TargetsPath, undefined, h.Bearer(token))
        assert.equal(targets.status, 200)
        assert.deepEqual(targets.body, { contribute: [{ name: 'acme-dev', status: EnvStatus.Running }], publish: [] })
    })

    it('a missing, unknown or console bearer is 401 signed-out on the bearer routes', async () =>
    {
        const console = await h.Sessions.Issue(EndpointKit.TenantId, FakeRelyingParty.PrincipalId)
        const consoleTargets = await h.Send('GET', EndpointKit.TargetsPath, undefined, h.Bearer(console.id))
        assert.equal(consoleTargets.status, 401)
        assert.deepEqual(consoleTargets.body, { error: 'signed-out' })
        assert.equal((await h.Send('GET', EndpointKit.ProfilePath, undefined)).status, 401)
        assert.equal((await h.Send('GET', EndpointKit.ProfilePath, undefined, h.Bearer('unknown'))).status, 401)
        assert.equal((await h.Send('POST', EndpointKit.SignOutPath, undefined, h.Bearer(console.id))).status, 401)
        assert.notEqual(await h.Sessions.Validate(console.id), null)
    })

    it('a wrong method is 405 and an unknown desktop path is not handled', async () =>
    {
        assert.equal((await h.Send('GET', EndpointKit.BeginPath, undefined)).status, 405)
        assert.equal((await h.Send('POST', EndpointKit.TargetsPath, undefined)).status, 405)
        assert.equal((await h.Send('GET', '/desktop/other', undefined)).status, 404)
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
        for (let i = 0; i < DesktopEndpoint.MaxBeginsPerWindow; i++)
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
        assert.equal(h.Rp.BeginKind, undefined)
    })
})

/** Runs a body against a started harness (optionally behind a trusted proxy) and disposes it. */
class AddressKit
{
    public static readonly Forwarded = 'x-forwarded-for'

    public static async With(trustedProxy: boolean, body: (h: EndpointHarness) => Promise<void>): Promise<void>
    {
        const h = new EndpointHarness(trustedProxy)
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
