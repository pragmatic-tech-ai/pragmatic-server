import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InMemoryAuthorizationCodeStore } from '../authorization-code-store.js';
import { AuthorizeEndpoint } from '../authorize-endpoint.js';
import type { AuthorizeResult } from '../authorize-endpoint.js';
import { IdpClientStore } from '../idp-client-store.js';
import { IdpRealmSet } from '../idp-host.js';
import { IdpRealm } from '../idp-realm.js';
import { IdpSsoCookie, IdpSsoSessionStore } from '../idp-sso-session.js';

class AuthorizeFixture
{
    public static readonly TenantId = 'tenant-1';
    public static readonly ClientId = 'client-1';
    public static readonly RedirectUri = 'https://app.example/cb';
    public static readonly Email = 'a@t';
    public static readonly PrincipalId = 'p-1';
    public static readonly Password = 'pw-correct-horse';
    public static readonly Challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    public static readonly State = 'st-1';
    public static readonly Nonce = 'no-1';

    public codes = new InMemoryAuthorizationCodeStore();
    public sso = new IdpSsoSessionStore();
    public endpoint!: AuthorizeEndpoint;

    public static async Run(body: (f: AuthorizeFixture) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-authz-'));
        try
        {
            const realm = await IdpRealm.OpenFor(dir, AuthorizeFixture.TenantId, 'T', randomBytes(32));
            await realm.SeedAccount(AuthorizeFixture.Email, AuthorizeFixture.PrincipalId, AuthorizeFixture.Password);
            const clients = new IdpClientStore();
            await clients.Register(AuthorizeFixture.TenantId, AuthorizeFixture.ClientId, [AuthorizeFixture.RedirectUri], 'secret');
            const f = new AuthorizeFixture();
            f.endpoint = new AuthorizeEndpoint(new IdpRealmSet([[AuthorizeFixture.TenantId, realm]]), clients, f.codes, f.sso, true);
            await body(f);
        }
        finally
        {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    public static Query(overrides: Record<string, string | undefined> = {}): URLSearchParams
    {
        const base: Record<string, string | undefined> = {
            response_type: 'code',
            client_id: AuthorizeFixture.ClientId,
            redirect_uri: AuthorizeFixture.RedirectUri,
            code_challenge: AuthorizeFixture.Challenge,
            code_challenge_method: 'S256',
            state: AuthorizeFixture.State,
            nonce: AuthorizeFixture.Nonce,
            ...overrides
        };
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(base))
        {
            if (v !== undefined)
            {
                q.set(k, v);
            }
        }
        return q;
    }

    public static Form(password: string): URLSearchParams
    {
        return new URLSearchParams({ email: AuthorizeFixture.Email, password });
    }

    public static Redirect(r: AuthorizeResult): { location: string; setCookie?: string }
    {
        assert.equal(r.kind, 'redirect');
        return r as { kind: 'redirect'; location: string; setCookie?: string };
    }
}

test('unknown client is rejected without issuing a code', () => AuthorizeFixture.Run(async f =>
{
    const r = await f.endpoint.HandleGet(AuthorizeFixture.TenantId, AuthorizeFixture.Query({ client_id: 'nope' }), undefined);
    assert.equal(r.kind, 'error');
}));

test('a redirect_uri off the allowlist is rejected', () => AuthorizeFixture.Run(async f =>
{
    const q = AuthorizeFixture.Query({ redirect_uri: 'https://evil.example/cb' });
    const r = await f.endpoint.HandleGet(AuthorizeFixture.TenantId, q, undefined);
    assert.equal(r.kind, 'error');
    const p = await f.endpoint.HandlePost(AuthorizeFixture.TenantId, q, undefined, AuthorizeFixture.Form(AuthorizeFixture.Password));
    assert.equal(p.kind, 'error');
}));

test('a missing or non-S256 code_challenge is rejected', () => AuthorizeFixture.Run(async f =>
{
    for (const o of [{ code_challenge: undefined }, { code_challenge: '' }, { code_challenge_method: 'plain' }, { code_challenge_method: undefined }])
    {
        const r = await f.endpoint.HandleGet(AuthorizeFixture.TenantId, AuthorizeFixture.Query(o), undefined);
        assert.equal(r.kind, 'error');
    }
}));

test('wrong response_type, missing state or nonce are rejected', () => AuthorizeFixture.Run(async f =>
{
    for (const o of [{ response_type: 'token' }, { state: undefined }, { nonce: undefined }])
    {
        const r = await f.endpoint.HandleGet(AuthorizeFixture.TenantId, AuthorizeFixture.Query(o), undefined);
        assert.equal(r.kind, 'error');
    }
}));

test('valid authorize with no SSO cookie returns the login page', () => AuthorizeFixture.Run(async f =>
{
    const r = await f.endpoint.HandleGet(AuthorizeFixture.TenantId, AuthorizeFixture.Query(), undefined);
    assert.equal(r.kind, 'loginPage');
}));

test('valid credentials set the SSO cookie and redirect with code and state', () => AuthorizeFixture.Run(async f =>
{
    const r = AuthorizeFixture.Redirect(await f.endpoint.HandlePost(
        AuthorizeFixture.TenantId, AuthorizeFixture.Query(), undefined, AuthorizeFixture.Form(AuthorizeFixture.Password)));
    assert.ok(r.setCookie?.startsWith(`${IdpSsoCookie.Name}=`));
    const url = new URL(r.location);
    assert.equal(url.origin + url.pathname, AuthorizeFixture.RedirectUri);
    assert.equal(url.searchParams.get('state'), AuthorizeFixture.State);
    const binding = await f.codes.Take(url.searchParams.get('code')!);
    assert.equal(binding?.Sub, AuthorizeFixture.PrincipalId);
    assert.equal(binding?.Nonce, AuthorizeFixture.Nonce);
    assert.equal(binding?.CodeChallenge, AuthorizeFixture.Challenge);
    assert.equal(binding?.ClientId, AuthorizeFixture.ClientId);
    assert.equal(binding?.RedirectUri, AuthorizeFixture.RedirectUri);
}));

test('a valid SSO cookie skips the login page and redirects with a code', () => AuthorizeFixture.Run(async f =>
{
    const issued = f.sso.Issue(AuthorizeFixture.PrincipalId, AuthorizeFixture.TenantId);
    const r = AuthorizeFixture.Redirect(await f.endpoint.HandleGet(
        AuthorizeFixture.TenantId, AuthorizeFixture.Query(), `${IdpSsoCookie.Name}=${issued.Id}`));
    const code = new URL(r.location).searchParams.get('code')!;
    assert.equal((await f.codes.Take(code))?.Sub, AuthorizeFixture.PrincipalId);
}));

test('bad credentials return the login page with a uniform error, no code issued', () => AuthorizeFixture.Run(async f =>
{
    const wrong = await f.endpoint.HandlePost(AuthorizeFixture.TenantId, AuthorizeFixture.Query(), undefined, AuthorizeFixture.Form('bad'));
    const ghost = await f.endpoint.HandlePost(AuthorizeFixture.TenantId, AuthorizeFixture.Query(), undefined,
        new URLSearchParams({ email: 'ghost@t', password: 'bad' }));
    assert.equal(wrong.kind, 'loginPage');
    assert.equal(ghost.kind, 'loginPage');
    assert.equal((wrong as { html: string }).html, (ghost as { html: string }).html);
    assert.match((wrong as { html: string }).html, /Invalid email or password/);
}));
