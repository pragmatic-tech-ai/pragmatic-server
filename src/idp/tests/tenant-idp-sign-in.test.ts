import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { importJWK, jwtVerify } from 'jose';
import { ComponentDescriptorBuilder } from '@pragmatic-tech-ai/pragmatic-component';
import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import { IdpTestFlow } from './idp-test-flow.js';
import { TenantIdpTestHost } from './tenant-idp-test-host.js';

class SignInFixture
{
    public static readonly Realm = 'tenant-1';
    public static readonly Email = 'ada@example.com';
    public static readonly Password = 'correct horse battery';
    public static readonly PrincipalId = 'p-ada';
    public static readonly ClientId = 'console';
    public static readonly Secret = 'console-secret';
    public static readonly Redirect = 'https://console.example/cb';
    public static readonly AfterLogout = 'https://console.example/signed-out';
    public static readonly Ledger = new ComponentDescriptorBuilder('ledger', '1.0.0').Role('finance', 'Books').Role('sales', 'Deals').Build();
}

describe('the realm sign-in service: sign-in, tokens, sessions', () =>
{
    const F = SignInFixture;
    let host: TenantIdpTestHost;
    let flow: IdpTestFlow;

    before(async () =>
    {
        host = await TenantIdpTestHost.Start({ Applications: [F.Ledger] });
        await host.Provision(F.Realm, { email: F.Email, principalId: F.PrincipalId, password: F.Password, displayName: 'Ada' },
            { clientId: F.ClientId, secret: F.Secret, redirectUris: [F.Redirect], postLogoutRedirectUris: [F.AfterLogout] });
        flow = new IdpTestFlow(host, F.Realm, F.ClientId, F.Secret, F.Redirect);
    });

    after(async () =>
    {
        await host.Close();
    });

    it('publishes discovery under /realms/<realm> and its keys', async () =>
    {
        const reply = await host.Http.Send('GET', flow.Issuer + RealmIssuer.DiscoveryPath);
        assert.equal(reply.Status, 200);
        const doc = reply.Json();
        assert.equal(doc.issuer, host.BaseUrl + '/realms/' + F.Realm);
        assert.equal(doc.authorization_endpoint, doc.issuer + '/protocol/openid-connect/auth');
        assert.equal(doc.token_endpoint, doc.issuer + '/protocol/openid-connect/token');
        assert.equal(doc.end_session_endpoint, doc.issuer + '/protocol/openid-connect/logout');
        assert.deepEqual(doc.grant_types_supported, ['authorization_code', 'refresh_token']);
        assert.deepEqual(doc.prompt_values_supported, ['none', 'login'], 'no sign-up without a source that offers it');
        const keys = (await host.Http.Send('GET', doc.jwks_uri)).Json();
        assert.equal(keys.keys.length, 1);
        assert.equal((await host.Http.Send('GET', host.Issuer('nope') + RealmIssuer.DiscoveryPath)).Status, 404);
    });

    it('serves the login page for a valid request, and refuses a bad one without redirecting', async () =>
    {
        const page = await flow.Authorize(flow.Request());
        assert.equal(page.Status, 200);
        assert.match(page.Header('content-type') ?? '', /text\/html/);
        assert.match(page.Text, /pragmatic-login/);
        assert.match(page.Header('content-security-policy') ?? '', /identitytoolkit\.googleapis\.com/);
        const bad = await flow.Authorize(flow.Request({ redirect_uri: 'https://evil.example/cb' }));
        assert.equal(bad.Status, 400);
        assert.equal(bad.Json().error, 'invalid_request');
    });

    it('signs in with a password, exchanges the code once and issues ID, access and refresh tokens', async () =>
    {
        const request = flow.Request();
        const login = await flow.PasswordLogin(request, F.Email, F.Password);
        assert.equal(login.Status, 200);
        assert.match(login.Header('set-cookie') ?? '', /idp_sso=.+; HttpOnly; SameSite=Lax; Path=\/realms\/tenant-1\/; Secure/);
        const code = IdpTestFlow.CodeOf(login.Json().redirect, request);
        const exchanged = await flow.Exchange(code, request);
        assert.equal(exchanged.Status, 200);
        const tokens = exchanged.Json();
        assert.equal(tokens.token_type, 'Bearer');
        assert.equal(typeof tokens.refresh_token, 'string');
        assert.equal(tokens.expires_in, 300);
        const claims = IdpTestFlow.Claims(tokens.id_token);
        assert.equal(claims.iss, flow.Issuer);
        assert.equal(claims.aud, F.ClientId);
        assert.equal(claims.sub, F.PrincipalId);
        assert.equal(claims.email, F.Email);
        assert.equal(claims.name, 'Ada');
        assert.equal(claims.nonce, request.Nonce);
        assert.deepEqual(claims.roles, []);
        assert.deepEqual(claims.app_roles, {});
        assert.equal((await flow.Exchange(code, request)).Json().error, 'invalid_grant', 'a code works once');
    });

    it('refuses a wrong password, a wrong client secret and a wrong verifier with one answer each', async () =>
    {
        const request = flow.Request();
        const wrong = await flow.PasswordLogin(request, F.Email, 'nope');
        assert.equal(wrong.Status, 401);
        assert.equal(wrong.Json().error, 'invalid_credentials');
        const login = await flow.PasswordLogin(request, F.Email, F.Password);
        const code = IdpTestFlow.CodeOf(login.Json().redirect, request);
        assert.equal((await flow.Exchange(code, request, 'wrong-secret')).Status, 401);
        const other = flow.Request();
        const otherLogin = await flow.PasswordLogin(other, F.Email, F.Password);
        assert.equal((await flow.Exchange(IdpTestFlow.CodeOf(otherLogin.Json().redirect, other), request)).Json().error, 'invalid_grant');
    });

    it('answers silently from the SSO session, but not for prompt=login, and login_required for prompt=none without one', async () =>
    {
        const { Cookie } = await flow.SignIn(F.Email, F.Password);
        const silent = flow.Request();
        const answered = await flow.Authorize(silent, Cookie);
        assert.equal(answered.Status, 302);
        assert.ok(IdpTestFlow.CodeOf(answered.Header('location')!, silent));
        assert.equal(answered.Header('set-cookie'), undefined, 'the existing session answers; no new one');
        assert.equal((await flow.Authorize(flow.Request({ prompt: 'login' }), Cookie)).Status, 200);
        const none = flow.Request({ prompt: 'none' });
        const refused = await flow.Authorize(none);
        assert.equal(refused.Status, 302);
        const location = new URL(refused.Header('location')!);
        assert.equal(location.searchParams.get('error'), 'login_required');
        assert.equal(location.searchParams.get('state'), none.State);
    });

    it('single sign-on across two clients of the realm: the second rides the session to a code with no page', async () =>
    {
        assert.equal((await host.Admin('POST', F.Realm + '/clients', { clientId: 'ledger', secret: 'ledger-secret', redirectUris: ['https://ledger.example/cb'] })).Status, 200);
        const { Cookie } = await flow.SignIn(F.Email, F.Password);
        const other = new IdpTestFlow(host, F.Realm, 'ledger', 'ledger-secret', 'https://ledger.example/cb');
        const request = other.Request();
        const answered = await other.Authorize(request, Cookie);
        assert.equal(answered.Status, 302);
        const tokens = (await other.Exchange(IdpTestFlow.CodeOf(answered.Header('location')!, request), request)).Json();
        assert.equal(IdpTestFlow.Claims(tokens.id_token).aud, 'ledger');
        assert.equal(IdpTestFlow.Claims(tokens.id_token).sub, F.PrincipalId);
        const second = other.Request();
        const code = IdpTestFlow.CodeOf((await other.Authorize(second, Cookie)).Header('location')!, second);
        assert.equal((await flow.Exchange(code, second)).Json().error, 'invalid_grant', 'another client cannot redeem it');
    });

    it('rotates refresh tokens, refuses a reused one and revokes its family', async () =>
    {
        const { Tokens } = await flow.SignIn(F.Email, F.Password);
        const first = await flow.Refresh(Tokens.refresh_token);
        assert.equal(first.Status, 200);
        const refreshed = first.Json();
        assert.notEqual(refreshed.refresh_token, Tokens.refresh_token);
        const claims = IdpTestFlow.Claims(refreshed.id_token);
        assert.equal(claims.sub, F.PrincipalId);
        assert.equal(claims.nonce, undefined, 'no nonce on refresh');
        assert.equal((await flow.Refresh(Tokens.refresh_token)).Json().error, 'invalid_grant', 'reuse is refused');
        assert.equal((await flow.Refresh(refreshed.refresh_token)).Json().error, 'invalid_grant', 'and the family is revoked');
    });

    it('revokes a refresh token (RFC 7009) and answers 200 for an unknown one', async () =>
    {
        const { Tokens } = await flow.SignIn(F.Email, F.Password);
        assert.equal((await flow.Revoke(Tokens.refresh_token)).Status, 200);
        assert.equal((await flow.Refresh(Tokens.refresh_token)).Status, 400);
        assert.equal((await flow.Revoke('unknown')).Status, 200);
    });

    it('logs out with an ID token hint: ends the SSO session and its refresh tokens, clears the cookie, returns to a registered URI', async () =>
    {
        const { Tokens, Cookie } = await flow.SignIn(F.Email, F.Password);
        const refused = await flow.Logout(Cookie, new URLSearchParams({ client_id: F.ClientId, post_logout_redirect_uri: 'https://evil.example/' }).toString());
        assert.equal(refused.Status, 400);
        const out = await flow.Logout(Cookie, new URLSearchParams({ id_token_hint: Tokens.id_token, post_logout_redirect_uri: F.AfterLogout, state: 's1' }).toString());
        assert.equal(out.Status, 302);
        assert.equal(out.Header('location'), F.AfterLogout + '?state=s1');
        assert.match(out.Header('set-cookie') ?? '', /idp_sso=; .*Max-Age=0/);
        assert.equal((await flow.Refresh(Tokens.refresh_token)).Status, 400);
        assert.equal((await flow.Authorize(flow.Request(), Cookie)).Status, 200, 'the old cookie shows the page again');
    });

    it('a logout without a valid hint asks first: the page posts back, and only the post signs out', async () =>
    {
        const { Tokens, Cookie } = await flow.SignIn(F.Email, F.Password);
        const forged = await flow.Logout(Cookie, new URLSearchParams({ id_token_hint: Tokens.id_token.slice(0, -4) + 'AAAA' }).toString());
        assert.equal(forged.Status, 200);
        assert.match(forged.Text, /<form method="post" action="\/realms\/tenant-1\/protocol\/openid-connect\/logout\?id_token_hint=/);
        assert.equal((await flow.Refresh(Tokens.refresh_token)).Status, 200, 'the confirmation page ended nothing');
        const crossSite = await host.Http.Send('POST', flow.Issuer + RealmIssuer.LogoutPath, { Headers: { cookie: Cookie!, origin: 'https://evil.example' } });
        assert.equal(crossSite.Status, 403);
        const posted = await flow.Logout(Cookie, '', 'POST');
        assert.equal(posted.Status, 200);
        assert.equal(posted.Json().signedOut, true);
        assert.equal((await flow.Authorize(flow.Request(), Cookie)).Status, 200);
    });

    it('signing in again over a live session (prompt=login) ends the old session and its refresh tokens', async () =>
    {
        const first = await flow.SignIn(F.Email, F.Password);
        const request = flow.Request({ prompt: 'login' });
        const again = await host.Http.Send('POST', flow.Issuer + RealmIssuer.LoginPath, { Json: { request: request.Query, method: 'password', email: F.Email, password: F.Password }, Headers: { origin: host.BaseUrl, cookie: first.Cookie! } });
        assert.equal(again.Status, 200);
        assert.equal((await flow.Refresh(first.Tokens.refresh_token)).Status, 400, 'the replaced session took its tokens with it');
        assert.equal((await flow.Authorize(flow.Request(), first.Cookie)).Status, 200, 'the replaced cookie no longer answers');
    });

    it('a replayed code revokes the refresh tokens its first exchange issued', async () =>
    {
        const request = flow.Request();
        const login = await flow.PasswordLogin(request, F.Email, F.Password);
        const code = IdpTestFlow.CodeOf(login.Json().redirect, request);
        const tokens = (await flow.Exchange(code, request)).Json();
        assert.equal((await flow.Exchange(code, request)).Json().error, 'invalid_grant');
        assert.equal((await flow.Refresh(tokens.refresh_token)).Status, 400);
    });

    it('a client re-registered with a new secret loses the refresh tokens issued under the old one', async () =>
    {
        await host.Admin('POST', F.Realm + '/clients', { clientId: 'rotating', secret: 'one', redirectUris: [F.Redirect] });
        const rotating = new IdpTestFlow(host, F.Realm, 'rotating', 'one', F.Redirect);
        const { Tokens } = await rotating.SignIn(F.Email, F.Password);
        await host.Admin('POST', F.Realm + '/clients', { clientId: 'rotating', secret: 'one', redirectUris: [F.Redirect] });
        const kept = await rotating.Refresh(Tokens.refresh_token);
        assert.equal(kept.Status, 200, 'the same secret again keeps them');
        await host.Admin('POST', F.Realm + '/clients', { clientId: 'rotating', secret: 'two', redirectUris: [F.Redirect] });
        const after = new IdpTestFlow(host, F.Realm, 'rotating', 'two', F.Redirect);
        assert.equal((await after.Refresh(kept.Json().refresh_token)).Status, 400);
    });

    it('issues roles and app_roles from the role mappings, and a refresh follows a mapping change', async () =>
    {
        const roles = (await host.Admin('GET', F.Realm + '/roles')).Json();
        assert.deepEqual(roles.map((r: { role: string }) => r.role), ['admin', 'ledger:finance', 'ledger:sales']);
        assert.equal((await host.Admin('POST', F.Realm + '/role-mappings', { role: 'admin', member: { kind: 'account', value: F.PrincipalId } })).Json().added, true);
        assert.equal((await host.Admin('POST', F.Realm + '/role-mappings', { role: 'ledger:finance', member: { kind: 'source-user', source: 'local', value: F.PrincipalId } })).Json().added, true);
        assert.equal((await host.Admin('POST', F.Realm + '/role-mappings', { role: 'ledger:nope', member: { kind: 'account', value: F.PrincipalId } })).Json().error, 'undeclared-application-role');
        const { Tokens } = await flow.SignIn(F.Email, F.Password);
        const claims = IdpTestFlow.Claims(Tokens.id_token);
        assert.deepEqual(claims.roles, ['admin']);
        assert.deepEqual(claims.app_roles, { ledger: ['finance'] });
        assert.equal((await host.Admin('DELETE', F.Realm + '/role-mappings', { role: 'admin', member: { kind: 'account', value: F.PrincipalId } })).Json().removed, true);
        const refreshed = IdpTestFlow.Claims((await flow.Refresh(Tokens.refresh_token)).Json().id_token);
        assert.deepEqual(refreshed.roles, []);
        assert.deepEqual(refreshed.app_roles, { ledger: ['finance'] });
        assert.equal((await host.Admin('DELETE', F.Realm + '/role-mappings', { role: 'ledger:finance', member: { kind: 'source-user', source: 'local', value: F.PrincipalId } })).Json().removed, true);
    });

    it('a password reset ends the SSO sessions and refresh tokens issued before it', async () =>
    {
        const { Tokens, Cookie } = await flow.SignIn(F.Email, F.Password);
        assert.equal((await host.Admin('POST', F.Realm + '/accounts/' + F.PrincipalId + '/password', { password: 'a new password' })).Status, 200);
        assert.equal((await flow.Refresh(Tokens.refresh_token)).Status, 400);
        assert.equal((await flow.Authorize(flow.Request(), Cookie)).Status, 200);
        const again = await flow.SignIn(F.Email, 'a new password');
        assert.equal(IdpTestFlow.Claims(again.Tokens.id_token).sub, F.PrincipalId);
        await host.Admin('POST', F.Realm + '/accounts/' + F.PrincipalId + '/password', { password: F.Password });
    });

    it('verifies its ID tokens against its own published keys', async () =>
    {
        const { Tokens } = await flow.SignIn(F.Email, F.Password);
        const jwks = (await host.Http.Send('GET', flow.Issuer + RealmIssuer.CertsPath)).Json();
        const key = await importJWK(jwks.keys[0], 'RS256');
        const verified = await jwtVerify(Tokens.id_token, key, { issuer: flow.Issuer, audience: F.ClientId });
        assert.equal(verified.payload.sub, F.PrincipalId);
    });
});
