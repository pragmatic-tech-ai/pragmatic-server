import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ComponentDescriptorBuilder } from '@pragmatic-tech-ai/pragmatic-component';
import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import { IdpTestFlow } from './idp-test-flow.js';
import { TenantIdpTestHost } from './tenant-idp-test-host.js';

class ProtocolFixture
{
    public static readonly Realm = 'tenant-p';
    public static readonly Email = 'max@example.com';
    public static readonly Password = 'max password 1';
    public static readonly PrincipalId = 'p-max';
    public static readonly ClientId = 'console';
    public static readonly Secret = 'console-secret';
    public static readonly Redirect = 'https://console.example/cb';
    public static readonly Cabinet = new ComponentDescriptorBuilder('cabinet', '2.0.0').Role('owner', 'Owns the account').Build();
}

describe('the realm sign-in service: protocol edges and the admin API', () =>
{
    const F = ProtocolFixture;
    let host: TenantIdpTestHost;
    let flow: IdpTestFlow;

    before(async () =>
    {
        host = await TenantIdpTestHost.Start();
        await host.Provision(F.Realm, { email: F.Email, principalId: F.PrincipalId, password: F.Password }, { clientId: F.ClientId, secret: F.Secret, redirectUris: [F.Redirect] });
        flow = new IdpTestFlow(host, F.Realm, F.ClientId, F.Secret, F.Redirect);
    });

    after(async () =>
    {
        await host.Close();
    });

    it('the token endpoint takes forms only, refuses an unknown grant, and accepts client_secret_basic', async () =>
    {
        const json = await host.Http.Send('POST', flow.Issuer + RealmIssuer.TokenPath, { Json: { grant_type: 'authorization_code' } });
        assert.equal(json.Status, 415);
        const unknown = await host.Http.Send('POST', flow.Issuer + RealmIssuer.TokenPath, { Form: { grant_type: 'password' } });
        assert.equal(unknown.Json().error, 'unsupported_grant_type');
        assert.equal(unknown.Header('cache-control'), 'no-store');
        const huge = await host.Http.Send('POST', flow.Issuer + RealmIssuer.TokenPath, { Form: { grant_type: 'refresh_token', refresh_token: 'x'.repeat(20000) } });
        assert.equal(huge.Status, 413);
        const request = flow.Request();
        const login = await flow.PasswordLogin(request, F.Email, F.Password);
        const basic = 'Basic ' + Buffer.from(F.ClientId + ':' + F.Secret).toString('base64');
        const exchanged = await host.Http.Send('POST', flow.Issuer + RealmIssuer.TokenPath, {
            Form: { grant_type: 'authorization_code', code: IdpTestFlow.CodeOf(login.Json().redirect, request), code_verifier: request.Verifier, redirect_uri: F.Redirect },
            Headers: { authorization: basic },
        });
        assert.equal(exchanged.Status, 200);
        assert.equal((await host.Http.Send('POST', host.Issuer('nope') + RealmIssuer.TokenPath, { Form: { grant_type: 'refresh_token' } })).Status, 400);
    });

    it('locks password sign-in after the realm\'s attempts, per account and address', async () =>
    {
        const request = flow.Request();
        for (let attempt = 0; attempt < 5; attempt++)
        {
            assert.equal((await flow.PasswordLogin(request, 'locked@example.com', 'wrong')).Status, 401);
        }
        const locked = await flow.PasswordLogin(request, 'locked@example.com', 'wrong');
        assert.equal(locked.Status, 429);
        assert.equal(locked.Json().error, 'too_many_attempts');
        assert.ok(Number(locked.Header('retry-after')) > 0);
    });

    it('refuses a bad login body, an unknown method, prompt=none with another prompt, and a cross-origin post', async () =>
    {
        const request = flow.Request();
        assert.equal((await flow.Login(request, { method: 'password' })).Status, 400);
        assert.equal((await flow.Login(request, { method: 'magic', email: F.Email, password: F.Password })).Status, 400);
        assert.equal((await flow.Authorize(flow.Request({ prompt: 'none login' }))).Status, 400);
        const foreign = await host.Http.Send('POST', flow.Issuer + RealmIssuer.LoginPath, { Json: { request: request.Query, method: 'password', email: F.Email, password: F.Password }, Headers: { origin: 'https://evil.example' } });
        assert.equal(foreign.Status, 403);
    });

    it('answers unknown realms, sources and paths with JSON 404s', async () =>
    {
        assert.equal((await host.Http.Send('GET', host.Issuer('nope') + RealmIssuer.LoginConfigPath)).Status, 404);
        assert.equal((await host.Http.Send('GET', flow.Issuer + '/broker/google/login?' + flow.Request().Query)).Json().error, 'unknown_source');
        assert.equal((await host.Http.Send('GET', host.BaseUrl + '/tenant-p/authorize')).Status, 404, 'the pre-realms path is gone');
        assert.equal((await host.Http.Send('GET', host.BaseUrl + '/_login/nothing.js')).Status, 404);
        const handler = await host.Http.Send('GET', host.BaseUrl + '/__/auth/handler?state=x');
        assert.equal(handler.Status, 200, 'the federated return handler serves the page, validating nothing');
        assert.match(handler.Text, /pragmatic-login/);
    });

    it('a logout without a redirect clears the cookie and says so', async () =>
    {
        const out = await flow.Logout(undefined);
        assert.equal(out.Status, 200);
        assert.equal(out.Json().signedOut, true);
        assert.match(out.Header('set-cookie') ?? '', /Max-Age=0/);
    });

    it('the admin API needs its token, describes a realm, and refuses reserved realm ids', async () =>
    {
        const denied = await host.Http.Send('GET', host.BaseUrl + '/_admin/realms/' + F.Realm);
        assert.equal(denied.Status, 401);
        const realm = (await host.Admin('GET', F.Realm)).Json();
        assert.equal(realm.issuer, flow.Issuer);
        assert.deepEqual(realm.sources, ['local']);
        assert.equal((await host.Admin('PUT', '_hidden', { displayName: 'x' })).Json().error, 'invalid_realm');
        assert.equal((await host.Admin('GET', 'nope/roles')).Json().error, 'unknown_realm');
        for (const uri of ['not a url', 'javascript:alert(1)', 'http://app.example/cb', 'https://app.example/cb#frag', 'https://user:pw@app.example/cb'])
        {
            assert.equal((await host.Admin('POST', F.Realm + '/clients', { clientId: 'x', secret: 's', redirectUris: [uri] })).Json().error, 'invalid_body', uri);
        }
        assert.equal((await host.Admin('POST', F.Realm + '/clients', { clientId: 'x', secret: 's', redirectUris: ['http://127.0.0.1/cb'] })).Status, 200, 'a native loopback redirect');
        const unauthenticated = await host.Http.Send('POST', host.BaseUrl + '/_admin/realms/' + F.Realm + '/clients', { Json: { clientId: 'y' } });
        assert.equal(unauthenticated.Status, 401);
    });

    it('declares and removes applications from component descriptors, which the assignable roles follow', async () =>
    {
        const body = JSON.parse(F.Cabinet.ToCanonicalJson());
        assert.equal((await host.Admin('PUT', F.Realm + '/applications/other', body)).Json().error, 'invalid_descriptor', 'the path names the application');
        assert.equal((await host.Admin('PUT', F.Realm + '/applications/cabinet', body)).Status, 200);
        let roles = (await host.Admin('GET', F.Realm + '/roles')).Json().map((r: { role: string }) => r.role);
        assert.deepEqual(roles, ['admin', 'cabinet:owner']);
        assert.equal((await host.Admin('DELETE', F.Realm + '/applications/cabinet')).Json().removed, true);
        roles = (await host.Admin('GET', F.Realm + '/roles')).Json().map((r: { role: string }) => r.role);
        assert.deepEqual(roles, ['admin']);
    });

    it('disables and enables a local account: a disabled one signs in no more and loses its refresh tokens', async () =>
    {
        const { Tokens } = await flow.SignIn(F.Email, F.Password);
        assert.equal((await host.Admin('POST', F.Realm + '/accounts/' + F.PrincipalId + '/disable')).Json().disabled, true);
        assert.equal((await flow.Refresh(Tokens.refresh_token)).Status, 400);
        assert.equal((await flow.PasswordLogin(flow.Request(), F.Email, F.Password)).Status, 401);
        assert.equal((await host.Admin('POST', F.Realm + '/accounts/' + F.PrincipalId + '/enable')).Json().disabled, false);
        assert.equal((await flow.PasswordLogin(flow.Request(), F.Email, F.Password)).Status, 200);
        assert.equal((await host.Admin('POST', F.Realm + '/accounts/nobody/disable')).Json().error, 'unknown_account');
    });

    it('stores realm secrets sealed, never echoing them, and refuses a path-like name', async () =>
    {
        const put = await host.Admin('PUT', F.Realm + '/secrets/google-client-secret', { value: 'very secret value' });
        assert.equal(put.Status, 200);
        assert.ok(!put.Text.includes('very secret value'));
        assert.equal(await host.Service.Realms.For(F.Realm)!.Secrets.Get('google-client-secret'), 'very secret value');
        const raw = await host.Session.Query('SELECT ciphertext FROM sealed_secrets', []);
        assert.ok(raw.every(row => !String(row.ciphertext).includes('very secret value')));
        assert.equal((await host.Admin('PUT', F.Realm + '/secrets/idp-password%2Fp-max', { value: 'x' })).Json().error, 'invalid_body');
        assert.equal((await host.Admin('DELETE', F.Realm + '/secrets/google-client-secret')).Status, 200);
        assert.equal(await host.Service.Realms.For(F.Realm)!.Secrets.Get('google-client-secret'), null);
    });
});
