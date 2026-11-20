import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IdentityPlatformPageConfig, IdentityPlatformProvider, IdentityPlatformRestClient } from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/client'
import { FederatedRoundTrip, PendingFederatedSignIn } from '../federated-round-trip.js'
import { BrowserLoginBackend, LoginAnswer } from '../login-backend.js'
import { LoginBootState } from '../login-boot-state.js'
import { LoginConfig } from '../login-config.js'
import { LoginPageLocation } from '../login-page-location.js'
import { FakeFetch, MemoryStorage } from './login-fakes.js'

describe('LoginPageLocation', () =>
{
    it('derives the issuer path and the authorize request from the page URL', () =>
    {
        const page = LoginPageLocation.From('https://login.test', '/realms/central/protocol/openid-connect/auth', '?client_id=c1&prompt=login%20create&login_hint=a%40b.test')
        assert.equal(page.IssuerPath, '/realms/central')
        assert.equal(page.Request, 'client_id=c1&prompt=login%20create&login_hint=a%40b.test')
        assert.equal(page.ConfigPath, '/realms/central/login/config')
        assert.equal(page.LoginPath, '/realms/central/login')
        assert.equal(page.AuthorizeUrl, 'https://login.test/realms/central/protocol/openid-connect/auth?' + page.Request)
        assert.equal(page.ContinueUrl, 'https://login.test/__/auth/handler')
        assert.equal(page.IsFederatedReturn, false)
        const back = LoginPageLocation.FromHref('https://login.test', '/__/auth/handler', '', 'https://login.test/__/auth/handler#id_token=t&state=g')
        assert.equal(back.IsFederatedReturn, true)
        assert.equal(back.Href, 'https://login.test/__/auth/handler#id_token=t&state=g')
        assert.equal(back.WithIssuer('/realms/central').ConfigPath, '/realms/central/login/config')
        assert.equal(page.PromptsCreate, true)
        assert.equal(page.LoginHint, 'a@b.test')
        const plain = page.WithRequest('client_id=c1')
        assert.equal(plain.PromptsCreate, false)
        assert.equal(plain.LoginHint, '')
        assert.equal(plain.Search, '?client_id=c1')
    })
})

describe('LoginConfig', () =>
{
    it('parses the realm config, with the Identity Platform page config', () =>
    {
        const config = LoginConfig.FromJson({
            realm: 'central',
            displayName: 'Central',
            local: false,
            sources: [{ id: 'g', kind: 'google', label: 'Google', login: '/realms/central/broker/g/login?' }],
            identityPlatform: { projectId: 'p', apiKey: 'k', authDomain: 'p.firebaseapp.com', providers: ['password', 'google.com'], tenantId: null },
            signUp: true,
        })
        assert.equal(config.Realm, 'central')
        assert.equal(config.Local, false)
        assert.equal(config.SignUp, true)
        assert.equal(config.Sources[0]!.Login, '/realms/central/broker/g/login?')
        assert.equal(config.IdentityPlatform?.ApiKey, 'k')
        assert.equal(config.IdentityPlatform?.Enables(IdentityPlatformProvider.Google), true)
        assert.equal(LoginConfig.FromJson({ realm: 'r', displayName: 'R', local: true, sources: [], identityPlatform: null, signUp: false }).IdentityPlatform, null)
    })

    it('rejects a malformed config', () =>
    {
        assert.throws(() => LoginConfig.FromJson(null))
        assert.throws(() => LoginConfig.FromJson({ realm: 1, displayName: 'R' }))
        assert.throws(() => LoginConfig.FromJson({ realm: 'r', displayName: 'R', sources: [{ id: 'x' }] }))
        assert.throws(() => LoginConfig.FromJson({ realm: 'r', displayName: 'R', identityPlatform: { apiKey: 'k' } }))
    })
})

describe('BrowserLoginBackend', () =>
{
    it('loads the config and posts JSON same-origin to <issuer>/login, reading the answers', async () =>
    {
        const seen: Array<{ url: string; init: RequestInit | undefined }> = []
        const replies = [
            new Response(JSON.stringify({ realm: 'central', displayName: 'C', local: true, sources: [], identityPlatform: null, signUp: false })),
            new Response(JSON.stringify({ redirect: 'https://app/cb' })),
            new Response(JSON.stringify({ error: 'too_many_attempts' }), { status: 429, headers: { 'Retry-After': '12' } }),
            new Response('not json', { status: 502 }),
        ]
        const fetchFn: typeof fetch = async (input, init) =>
        {
            seen.push({ url: String(input), init })
            return replies.shift()!
        }
        const backend = new BrowserLoginBackend(LoginPageLocation.From('https://h', '/realms/central/protocol/openid-connect/auth', '?a=1'), fetchFn)
        assert.equal((await backend.LoadConfig()).Realm, 'central')
        assert.equal(seen[0]!.url, '/realms/central/login/config')
        const answer = await backend.Post({ request: 'a=1', method: 'password', email: 'e', password: 'p' })
        assert.equal(answer.Redirect, 'https://app/cb')
        assert.equal(seen[1]!.url, '/realms/central/login')
        assert.equal(seen[1]!.init?.method, 'POST')
        assert.equal(seen[1]!.init?.credentials, 'same-origin')
        assert.equal((seen[1]!.init?.headers as Record<string, string>)['Content-Type'], 'application/json')
        assert.deepEqual(JSON.parse(String(seen[1]!.init?.body)), { request: 'a=1', method: 'password', email: 'e', password: 'p' })
        const throttled = await backend.Post({})
        assert.equal(throttled.Error, LoginAnswer.TooManyAttempts)
        assert.equal(throttled.RetryAfterSeconds, 12)
        assert.equal((await backend.Post({})).Error, LoginAnswer.Unavailable)
        const offline = new BrowserLoginBackend(LoginPageLocation.From('https://h', '/x', ''), async () => { throw new TypeError('offline') })
        assert.equal((await offline.Post({})).Error, LoginAnswer.Unavailable)
    })

    it('reads a bad request\'s description', () =>
    {
        const answer = LoginAnswer.FromResponse(400, { error: 'invalid_request', error_description: 'bad' }, null)
        assert.equal(answer.Error, 'invalid_request')
        assert.equal(answer.Description, 'bad')
        assert.equal(answer.Redirect, undefined)
    })
})

describe('the shared Identity Platform client (federated calls, 0.15.0)', () =>
{
    it('createAuthUri posts the provider, the handler continue URI and the tenant; signInWithIdp the whole URL and session', async () =>
    {
        const fake = new FakeFetch()
            .Ok('accounts:createAuthUri', { authUri: 'https://accounts.google.com/x', sessionId: 's1', providerId: 'google.com' })
            .Ok('accounts:signInWithIdp', { localId: 'u1', idToken: 'tok', email: 'a@b.test', providerId: 'google.com' })
        const client = IdentityPlatformRestClient.For(new IdentityPlatformPageConfig('p', 'the-key', 'p.firebaseapp.com', [IdentityPlatformProvider.Google], 'tenant-a'), fake.Fetch)
        const start = await client.CreateAuthUri(IdentityPlatformProvider.Google, 'https://login.test/__/auth/handler')
        assert.equal(start.AuthUri, 'https://accounts.google.com/x')
        assert.equal(start.SessionId, 's1')
        assert.equal(fake.Calls[0]!.body.continueUri, 'https://login.test/__/auth/handler')
        assert.equal((await client.SignInWithIdp('https://login.test/__/auth/handler#id_token=g', 's1')).IdToken, 'tok')
        assert.equal(fake.Calls[1]!.body.requestUri, 'https://login.test/__/auth/handler#id_token=g')
    })
})

describe('FederatedRoundTrip', () =>
{
    it('gives the saved sign-in back once, only when the page came back with more than it left with', () =>
    {
        const storage = new MemoryStorage()
        const trip = new FederatedRoundTrip(storage)
        assert.equal(trip.Take('a=1'), undefined)
        trip.Save(new PendingFederatedSignIn('s1', 'a=1', '/realms/central'))
        assert.deepEqual(trip.Take('a=1&code=c'), new PendingFederatedSignIn('s1', 'a=1', '/realms/central'))
        assert.equal(trip.Take('a=1&code=c'), undefined)
        trip.Save(new PendingFederatedSignIn('s1', 'a=1', '/realms/central'))
        assert.equal(trip.Take('a=1'), undefined)
        assert.equal(storage.Items.size, 0)
        storage.setItem('pragmatic-login.federated', 'not json')
        assert.equal(trip.Take('x'), undefined)
    })
})

describe('LoginBootState', () =>
{
    it('reads failed only from the exact flag', () =>
    {
        assert.equal(LoginBootState.FromContent('failed').Failed, true)
        assert.equal(LoginBootState.FromContent('ready').Failed, false)
        assert.equal(LoginBootState.FromContent(null).Failed, false)
        assert.equal(LoginBootState.FromContent('FAILED').Failed, false)
    })
})

describe('FederatedRoundTrip.Locate', () =>
{
    it('puts a page served at the federated handler under the realm its round trip began in, removing nothing', () =>
    {
        const storage = new MemoryStorage()
        const trip = new FederatedRoundTrip(storage)
        const handler = LoginPageLocation.FromHref('https://login.test', '/__/auth/handler', '', 'https://login.test/__/auth/handler#x')
        assert.equal(trip.Locate(handler).IssuerPath, '/__/auth/handler', 'nothing saved: left as it is')
        trip.Save(new PendingFederatedSignIn('s1', 'a=1', '/realms/central'))
        assert.equal(trip.Locate(handler).IssuerPath, '/realms/central')
        assert.equal(trip.Locate(handler).Href, 'https://login.test/__/auth/handler#x')
        const page = LoginPageLocation.From('https://login.test', '/realms/other/protocol/openid-connect/auth', '?a=1')
        assert.equal(trip.Locate(page).IssuerPath, '/realms/other', 'only the handler page is relocated')
        assert.notEqual(trip.Take(''), undefined, 'still saved')
    })
})
