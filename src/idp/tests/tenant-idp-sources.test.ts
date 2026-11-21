import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing';
import { FakeIdentityPlatform, FakeIdentityPlatformHttp, FakeIdentityPlatformRest } from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/testing';
import { IdentityPlatformPageConfig, IdentityPlatformRestClient } from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/client';
import { IdpSourceClients } from '../idp-realm.js';
import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import { IdpTestFlow } from './idp-test-flow.js';
import { RealmTestConfiguration } from './realm-test-configuration.js';
import { TenantIdpTestHost } from './tenant-idp-test-host.js';

class SourcesFixture
{
    public static readonly Central = 'central';
    public static readonly Tenant = 'tenant-9';
    public static readonly ClientId = 'cabinet';
    public static readonly Secret = 'cabinet-secret';
    public static readonly Redirect = 'https://cabinet.example/cb';
    public static readonly UpstreamIssuer = 'https://upstream.example/realm';
    public static readonly Email = 'grace@example.com';
    public static readonly Password = 'a long password';
}

describe('the realm sign-in service: identity sources', () =>
{
    const F = SourcesFixture;
    let host: TenantIdpTestHost;
    let platform: FakeIdentityPlatform;
    let upstream: FakeOidcIdp;
    let upstreamHttp: FakeOidcHttpClient;

    before(async () =>
    {
        platform = await FakeIdentityPlatform.Create();
        upstream = await FakeOidcIdp.Create(F.UpstreamIssuer);
        upstreamHttp = new FakeOidcHttpClient(upstream);
        const central = RealmTestConfiguration.Of(F.Central, { options: { identityPlatform: { projectId: platform.ProjectId, apiKey: 'secret:realm/gip-browser-key' } } },
            { [RealmTestConfiguration.Secret('identityPlatform', 'apiKey')]: FakeIdentityPlatformRest.ApiKey }, 'Pragmatic');
        const tenant = RealmTestConfiguration.Of(F.Tenant, { options: { oidc: { issuer: F.UpstreamIssuer, discoveryUrl: upstream.DiscoveryUrl, clientId: 'upstream-client', clientSecret: 'secret:realm/upstream' }, local: {} } },
            { [RealmTestConfiguration.Secret('oidc', 'clientSecret')]: 'upstream-secret' });
        host = await TenantIdpTestHost.Start({ Configurations: [central, tenant], SourceClients: new IdpSourceClients(upstreamHttp, new FakeIdentityPlatformHttp(platform)) });
        for (const realm of [F.Central, F.Tenant])
        {
            assert.equal((await host.Admin('POST', realm + '/clients', { clientId: F.ClientId, secret: F.Secret, redirectUris: [F.Redirect] })).Status, 200);
        }
    });

    after(async () =>
    {
        await host.Close();
    });

    it('offers sign-up and the Identity Platform page config where the realm has that source', async () =>
    {
        const flow = new IdpTestFlow(host, F.Central, F.ClientId, F.Secret, F.Redirect);
        const config = (await host.Http.Send('GET', flow.Issuer + RealmIssuer.LoginConfigPath)).Json();
        assert.equal(config.displayName, 'Pragmatic');
        assert.equal(config.local, false);
        assert.equal(config.signUp, true);
        assert.equal(config.identityPlatform.apiKey, FakeIdentityPlatformRest.ApiKey);
        assert.equal(config.identityPlatform.projectId, platform.ProjectId);
        const discovery = (await host.Http.Send('GET', flow.Issuer + RealmIssuer.DiscoveryPath)).Json();
        assert.ok(discovery.prompt_values_supported.includes('create'));
        assert.equal((await flow.Authorize(flow.Request({ prompt: 'create' }))).Status, 200, 'prompt=create shows the page (sign-up mode)');
    });

    it('signs up through Identity Platform: refused until the email is verified, then signed in with a stable account', async () =>
    {
        const flow = new IdpTestFlow(host, F.Central, F.ClientId, F.Secret, F.Redirect);
        const config = IdentityPlatformPageConfig.FromJson((await host.Http.Send('GET', flow.Issuer + RealmIssuer.LoginConfigPath)).Json().identityPlatform);
        const rest = new FakeIdentityPlatformRest(platform);
        const client = IdentityPlatformRestClient.For(config, rest.Fetch);
        const signedUp = await client.SignUp(F.Email, F.Password);
        const request = flow.Request({ prompt: 'create' });
        const unverified = await flow.Login(request, { method: 'identityPlatform', idToken: signedUp.IdToken });
        assert.equal(unverified.Status, 401);
        assert.equal(unverified.Json().error, 'email_not_verified');
        await client.SendEmailVerification(signedUp.IdToken);
        rest.VerifyEmail(F.Email);
        const signedIn = await client.SignInWithPassword(F.Email, F.Password);
        const login = await flow.Login(request, { method: 'identityPlatform', idToken: signedIn.IdToken });
        assert.equal(login.Status, 200);
        const tokens = (await flow.Exchange(IdpTestFlow.CodeOf(login.Json().redirect, request), request)).Json();
        const claims = IdpTestFlow.Claims(tokens.id_token);
        assert.equal(claims.email, F.Email);
        assert.equal(claims.email_verified, true);
        assert.notEqual(claims.sub, signedIn.Uid, 'the realm account id, linked to the Identity Platform uid');
        const second = flow.Request();
        const again = await flow.Login(second, { method: 'identityPlatform', idToken: (await client.SignInWithPassword(F.Email, F.Password)).IdToken });
        const claims2 = IdpTestFlow.Claims((await flow.Exchange(IdpTestFlow.CodeOf(again.Json().redirect, second), second)).Json().id_token);
        assert.equal(claims2.sub, claims.sub);
        assert.equal((await flow.Login(flow.Request(), { method: 'identityPlatform', idToken: 'not-a-token' })).Json().error, 'invalid_credentials');
    });

    it('signs in through an upstream OIDC source, carrying the request through the round trip, with roles from its groups', async () =>
    {
        const flow = new IdpTestFlow(host, F.Tenant, F.ClientId, F.Secret, F.Redirect);
        assert.equal((await host.Admin('POST', F.Tenant + '/role-mappings', { role: 'admin', member: { kind: 'source-group', source: 'oidc', value: 'tenant-admins' } })).Json().added, true);
        const config = (await host.Http.Send('GET', flow.Issuer + RealmIssuer.LoginConfigPath)).Json();
        assert.deepEqual(config.sources.map((s: { id: string }) => s.id), ['oidc']);
        const request = flow.Request();
        const begin = await host.Http.Send('GET', host.BaseUrl + config.sources[0].login + request.Query);
        assert.equal(begin.Status, 302);
        const upstreamAuthorize = new URL(begin.Header('location')!);
        assert.equal(upstreamAuthorize.origin + upstreamAuthorize.pathname, upstream.AuthorizationEndpoint);
        assert.equal(upstreamAuthorize.searchParams.get('redirect_uri'), flow.Issuer + '/broker/oidc/callback');
        const idToken = await upstream.MintIdToken({ sub: 'up-42', aud: 'upstream-client', nonce: upstreamAuthorize.searchParams.get('nonce'), email: 'up@example.com', name: 'Up Stream', groups: ['tenant-admins'] });
        upstreamHttp.NextTokenResponse = upstream.TokenResponse(idToken);
        const binding = begin.Cookie();
        assert.match(begin.Header('set-cookie') ?? '', /idp_broker=.+; HttpOnly; SameSite=Lax; Path=\/realms\/tenant-9\/broker\//);
        const callback = await host.Http.Send('GET', flow.Issuer + '/broker/oidc/callback?' + new URLSearchParams({ code: 'upstream-code', state: upstreamAuthorize.searchParams.get('state')! }).toString(), { Headers: { cookie: binding! } });
        assert.equal(callback.Status, 302);
        assert.match(callback.Header('set-cookie') ?? '', /idp_sso=/);
        assert.match(callback.Header('set-cookie') ?? '', /idp_broker=; /, 'the binding is cleared');
        const tokens = (await flow.Exchange(IdpTestFlow.CodeOf(callback.Header('location')!, request), request)).Json();
        const claims = IdpTestFlow.Claims(tokens.id_token);
        assert.equal(claims.email, 'up@example.com');
        assert.deepEqual(claims.roles, ['admin']);
        const replay = await host.Http.Send('GET', flow.Issuer + '/broker/oidc/callback?' + new URLSearchParams({ code: 'upstream-code', state: upstreamAuthorize.searchParams.get('state')! }).toString(), { Headers: { cookie: binding! } });
        assert.equal(replay.Status, 401, 'a flow state works once');
    });

    it('refuses an upstream callback in a browser that did not begin the sign-in (login CSRF)', async () =>
    {
        const flow = new IdpTestFlow(host, F.Tenant, F.ClientId, F.Secret, F.Redirect);
        const request = flow.Request();
        const begin = await host.Http.Send('GET', flow.Issuer + '/broker/oidc/login?' + request.Query);
        const authorize = new URL(begin.Header('location')!);
        upstreamHttp.NextTokenResponse = upstream.TokenResponse(await upstream.MintIdToken({ sub: 'attacker', aud: 'upstream-client', nonce: authorize.searchParams.get('nonce'), email: 'evil@example.com' }));
        const victim = await host.Http.Send('GET', flow.Issuer + '/broker/oidc/callback?' + new URLSearchParams({ code: 'c', state: authorize.searchParams.get('state')! }).toString());
        assert.equal(victim.Status, 401);
        assert.doesNotMatch(victim.Header('set-cookie') ?? '', /idp_sso=[^;]/);
    });

    it('a disabled federated account signs in no more', async () =>
    {
        const flow = new IdpTestFlow(host, F.Central, F.ClientId, F.Secret, F.Redirect);
        const config = IdentityPlatformPageConfig.FromJson((await host.Http.Send('GET', flow.Issuer + RealmIssuer.LoginConfigPath)).Json().identityPlatform);
        const rest = new FakeIdentityPlatformRest(platform);
        const client = IdentityPlatformRestClient.For(config, rest.Fetch);
        await client.SignUp('off@example.com', 'off password 1');
        rest.VerifyEmail('off@example.com');
        const request = flow.Request();
        const login = await flow.Login(request, { method: 'identityPlatform', idToken: (await client.SignInWithPassword('off@example.com', 'off password 1')).IdToken });
        const accountId = IdpTestFlow.Claims((await flow.Exchange(IdpTestFlow.CodeOf(login.Json().redirect, request), request)).Json().id_token).sub as string;
        assert.equal((await host.Admin('POST', F.Central + '/accounts/' + accountId + '/disable')).Status, 200);
        const refused = await flow.Login(flow.Request(), { method: 'identityPlatform', idToken: (await client.SignInWithPassword('off@example.com', 'off password 1')).IdToken });
        assert.equal(refused.Status, 401);
    });

    it('grants nothing from a mapping naming a source the realm does not have', async () =>
    {
        assert.equal((await host.Admin('POST', F.Central + '/role-mappings', { role: 'admin', member: { kind: 'source-group', source: 'google', value: 'x' } })).Json().added, true);
        const realm = host.Service.Realms.For(F.Central)!;
        assert.deepEqual(realm.Settings.SourceIds(), ['identityPlatform']);
    });
});
