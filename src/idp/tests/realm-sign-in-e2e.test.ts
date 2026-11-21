import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { OidcRelyingParty, type IOidcClientConfig } from '@pragmatic-tech-ai/pragmatic-app-host';
import { ComponentDescriptorBuilder } from '@pragmatic-tech-ai/pragmatic-component';
import { CaTrustingHttpClient, InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc';
import { FakeIdentityPlatform, FakeIdentityPlatformHttp, FakeIdentityPlatformRest } from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/testing';
import { IdentityPlatformPageConfig, IdentityPlatformRestClient } from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/client';
import { IdpSourceClients } from '../idp-realm.js';
import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import { RealmTestConfiguration } from './realm-test-configuration.js';
import { TenantIdpTestHost } from './tenant-idp-test-host.js';

class EndToEndFixture
{
    public static readonly Tenant = 'tenant-e2e';
    public static readonly Central = 'central';
    public static readonly Application = 'ledger';
    public static readonly ClientId = 'ledger';
    public static readonly Secret = 'ledger-client-secret';
    public static readonly Redirect = 'https://ledger.example/auth/callback';
    public static readonly Email = 'lin@example.com';
    public static readonly Password = 'a password long enough';
    public static readonly PrincipalId = 'p-lin';
    public static readonly Ledger = new ComponentDescriptorBuilder('ledger', '1.0.0').Role('finance', 'Books').Role('viewer', 'Reads').Build();
}

/** The browser: follows the relying party's authorize URL to the login page and posts the login page's JSON. */
class TestBrowser
{
    public constructor(private readonly host: TenantIdpTestHost)
    {
    }

    /** Loads the login page at the authorize URL, signs in by `body`, and answers the redirect, code and SSO cookie. */
    public async SignIn(authorizeUrl: string, body: Record<string, unknown>): Promise<{ Code: string; State: string; Cookie: string | undefined }>
    {
        const page = await this.host.Http.Send('GET', authorizeUrl);
        assert.equal(page.Status, 200, 'the login page is shown');
        const url = new URL(authorizeUrl);
        const issuer = url.origin + url.pathname.slice(0, -RealmIssuer.AuthorizePath.length);
        const login = await this.host.Http.Send('POST', issuer + RealmIssuer.LoginPath, { Json: { request: url.search.slice(1), ...body }, Headers: { origin: url.origin } });
        assert.equal(login.Status, 200, login.Text);
        const redirect = new URL(login.Json().redirect);
        return { Code: redirect.searchParams.get('code')!, State: redirect.searchParams.get('state')!, Cookie: login.Cookie() };
    }
}

describe('end to end: a relying party signs in through the realm sign-in service', () =>
{
    const F = EndToEndFixture;
    let host: TenantIdpTestHost;
    let platform: FakeIdentityPlatform;
    let rp: OidcRelyingParty;
    let browser: TestBrowser;

    before(async () =>
    {
        platform = await FakeIdentityPlatform.Create();
        const central = RealmTestConfiguration.Of(F.Central, { options: { identityPlatform: { projectId: platform.ProjectId, apiKey: 'secret:realm/gip-browser-key' } } },
            { [RealmTestConfiguration.Secret('identityPlatform', 'apiKey')]: FakeIdentityPlatformRest.ApiKey });
        host = await TenantIdpTestHost.Start({ Configurations: [central], Applications: [F.Ledger], SourceClients: new IdpSourceClients(undefined, new FakeIdentityPlatformHttp(platform)) });
        await host.Provision(F.Tenant, { email: F.Email, principalId: F.PrincipalId, password: F.Password }, { clientId: F.ClientId, secret: F.Secret, redirectUris: [F.Redirect] });
        assert.equal((await host.Admin('POST', F.Central + '/clients', { clientId: F.ClientId, secret: F.Secret, redirectUris: [F.Redirect] })).Status, 200);
        rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore(), { Http: new CaTrustingHttpClient(host.Ca) });
        browser = new TestBrowser(host);
    });

    after(async () =>
    {
        await host.Close();
    });

    function ClientOf(realm: string): IOidcClientConfig
    {
        const issuer = host.Issuer(realm);
        return { Issuer: issuer, DiscoveryUrl: issuer + RealmIssuer.DiscoveryPath, ClientId: F.ClientId, ClientSecret: F.Secret, RedirectUri: F.Redirect, Application: F.Application, RequiredClaims: ['iat', 'email'] };
    }

    it('local account: roles and app_roles per the mappings, a refresh, and a logout that ends the refresh', async () =>
    {
        await host.Admin('POST', F.Tenant + '/role-mappings', { role: 'admin', member: { kind: 'account', value: F.PrincipalId } });
        await host.Admin('POST', F.Tenant + '/role-mappings', { role: 'ledger:finance', member: { kind: 'source-user', source: 'local', value: F.PrincipalId } });
        const client = ClientOf(F.Tenant);
        const begun = await rp.Begin(client);
        const signedIn = await browser.SignIn(begun.Url, { method: 'password', email: F.Email, password: F.Password });
        assert.equal(signedIn.State, begun.State);
        const outcome = await rp.CompleteWithTokens(client, signedIn.Code, signedIn.State);
        assert.equal(outcome.Result.Subject, F.PrincipalId);
        assert.deepEqual(outcome.Result.Claims.Values('roles'), ['admin']);
        assert.deepEqual(outcome.Result.Claims.Values('app_roles'), ['finance']);
        assert.equal(outcome.Result.Claims.First('email'), F.Email);
        const refreshToken = outcome.Tokens.RefreshToken;
        assert.notEqual(refreshToken, null, 'a confidential client gets a refresh token');
        const refreshed = await rp.Refresh(client, refreshToken!, F.PrincipalId);
        assert.notEqual(refreshed, null);
        assert.notEqual(refreshed!.RefreshToken, refreshToken, 'rotated');
        const loggedOut = await host.Http.Send('GET', host.Issuer(F.Tenant) + RealmIssuer.LogoutPath + '?' + new URLSearchParams({ id_token_hint: refreshed!.IdToken }).toString(), { Headers: { cookie: signedIn.Cookie! } });
        assert.equal(loggedOut.Status, 200);
        assert.equal(await rp.Refresh(client, refreshed!.RefreshToken!, F.PrincipalId), null, 'logout ended the refresh tokens of the session');
    });

    it('Identity Platform account (fake): signs up, verifies, signs in, gets its application role, refreshes, logs out', async () =>
    {
        const client = ClientOf(F.Central);
        const config = IdentityPlatformPageConfig.FromJson((await host.Http.Send('GET', host.Issuer(F.Central) + RealmIssuer.LoginConfigPath)).Json().identityPlatform);
        const rest = new FakeIdentityPlatformRest(platform);
        const gip = IdentityPlatformRestClient.For(config, rest.Fetch);
        await gip.SignUp('new@example.com', 'another long password');
        rest.VerifyEmail('new@example.com');
        const session = await gip.SignInWithPassword('new@example.com', 'another long password');
        const begun = await rp.Begin(client, { SignUp: true });
        assert.equal(new URL(begun.Url).searchParams.get('prompt'), 'create', 'the issuer advertises sign-up, so the relying party asks for it');
        const first = await browser.SignIn(begun.Url, { method: 'identityPlatform', idToken: session.IdToken });
        const outcome = await rp.CompleteWithTokens(client, first.Code, first.State);
        const accountId = outcome.Result.Subject;
        assert.deepEqual(outcome.Result.Claims.Values('app_roles'), []);
        await host.Admin('POST', F.Central + '/role-mappings', { role: 'ledger:viewer', member: { kind: 'account', value: accountId } });
        const refreshed = await rp.Refresh(client, outcome.Tokens.RefreshToken!, accountId);
        assert.notEqual(refreshed, null);
        const payload = JSON.parse(Buffer.from(refreshed!.IdToken.split('.')[1], 'base64url').toString('utf8'));
        assert.deepEqual(payload.app_roles, { ledger: ['viewer'] }, 'the refresh follows the new mapping');
        const loggedOut = await host.Http.Send('POST', host.Issuer(F.Central) + RealmIssuer.LogoutPath, { Headers: { cookie: first.Cookie!, origin: host.BaseUrl } });
        assert.equal(loggedOut.Status, 200);
        assert.equal(await rp.Refresh(client, refreshed!.RefreshToken!, accountId), null);
    });
});
