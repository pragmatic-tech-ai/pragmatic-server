import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { Tenant, TenantKind, IdentityConfig, DelegationDepth } from '@pragmatic-tech-ai/todl-identity'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { OidcAuthenticator, OidcResolvedConfig, OidcDiscovery, JwksCache, ClaimsMapper, ClaimArrayGroupStrategy, InMemoryOidcFlowStateStore, FakeOidcIdp, FakeOidcHttpClient } from '@pragmatic-tech-ai/todl-identity-cloud'
import { AuthHttpEndpoint } from '../auth-http-endpoint.js'

class OidcFixture
{
    public static readonly ClientId = 'client-1'
    public static readonly RedirectUri = 'https://app.test/cb'

    public constructor(
        public readonly Idp: FakeOidcIdp,
        public readonly Http: FakeOidcHttpClient,
        public readonly Store: InMemoryOidcFlowStateStore,
        public readonly Endpoint: AuthHttpEndpoint)
    {
    }

    public static async Create(): Promise<OidcFixture>
    {
        const idp = await FakeOidcIdp.Create()
        const http = new FakeOidcHttpClient(idp)
        const store = new InMemoryOidcFlowStateStore()
        const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
        const resolved = new OidcResolvedConfig(idp.DiscoveryUrl, idp.Issuer, OidcFixture.ClientId, OidcFixture.RedirectUri, ['openid', 'email'], null, 'client_secret')
        const authenticator = new OidcAuthenticator({
            Http: http,
            Discovery: new OidcDiscovery(http),
            Jwks: new JwksCache(http),
            FlowStates: store,
            Secrets: pack.Secrets,
            Claims: new ClaimsMapper(new Map([['email', 'email']]), new ClaimArrayGroupStrategy('groups')),
            Config: new IdentityConfig('server-pack', DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map()),
            Resolved: resolved,
        })
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        return new OidcFixture(idp, http, store, new AuthHttpEndpoint(pack, tenant, authenticator))
    }

    public Serve(): Promise<{ base: string; close: () => Promise<void> }>
    {
        const server = createServer((req, res) => void this.Endpoint.Handle(req, res))
        return new Promise(resolve =>
        {
            server.listen(0, '127.0.0.1', () =>
            {
                const port = (server.address() as AddressInfo).port
                resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(done => server.close(() => done())) })
            })
        })
    }
}

test('OIDC begin issues a 302 with a state and callback mints a session', async () =>
{
    const fixture = await OidcFixture.Create()
    const served = await fixture.Serve()
    try
    {
        const begin = await fetch(`${served.base}/auth/oidc/begin`, { redirect: 'manual' })
        assert.equal(begin.status, 302)
        const location = begin.headers.get('location')
        assert.ok(location !== null)
        const state = new URL(location!).searchParams.get('state')
        assert.ok(state !== null)

        const flow = fixture.Store.Peek(state!)
        assert.ok(flow !== null)
        fixture.Http.NextTokenResponse = { id_token: await fixture.Idp.MintIdToken({ sub: 'u1', aud: OidcFixture.ClientId, nonce: flow!.Nonce, email: 'a@x.io', groups: [] }), token_type: 'Bearer' }

        const callback = await fetch(`${served.base}/auth/oidc/callback?code=abc&state=${encodeURIComponent(state!)}`)
        assert.equal(callback.status, 200)
        const payload = await callback.json() as { token: string }
        assert.ok(payload.token.length > 0)
    }
    finally
    {
        await served.close()
    }
})

test('OIDC routes are 404 when the endpoint has no authenticator', async () =>
{
    const pack = await ServerIdentityPack.Open(new FakeStorage(), randomBytes(32))
    const endpoint = new AuthHttpEndpoint(pack, new Tenant('t1', TenantKind.SelfHosted, 'Tenant One'))
    const server = createServer((req, res) => void endpoint.Handle(req, res))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try
    {
        assert.equal((await fetch(`${base}/auth/oidc/begin`, { redirect: 'manual' })).status, 404)
        assert.equal((await fetch(`${base}/auth/oidc/begin`, { method: 'POST' })).status, 404)
        assert.equal((await fetch(`${base}/auth/oidc/callback?code=x&state=y`)).status, 404)
    }
    finally
    {
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
})
