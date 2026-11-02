import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { DevCa, IdpTlsMaterial } from '../dev-ca.js';
import { IdpClientStore } from '../idp-client-store.js';
import { IdpHost, IdpRealmSet } from '../idp-host.js';
import { IdpLoginPage } from '../idp-login-page.js';
import { IdpLoginThrottle } from '../idp-login-throttle.js';
import { IdpRealm } from '../idp-realm.js';
import { IdpSigningKey } from '../idp-signing-key.js';
import { IdpSsoSessionStore } from '../idp-sso-session.js';
import { InMemoryAuthorizationCodeStore } from '../authorization-code-store.js';

interface Reply
{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
}

// An IdP host serving a sign-in app built into a temp directory (index.html plus one asset).
class LoginFixture
{
    public static readonly TenantId = 'tenant-1';
    public static readonly Email = 'o@t';
    public static readonly Password = 'pw-Aa1-secret';
    public static readonly Index = '<!doctype html><html><head><meta name="pragmatic-login" content="ready">'
        + '<script type="module" src="/_login/assets/app.js"></script></head><body><div id="app"></div></body></html>';
    public static readonly AssetText = 'console.log(1)';
    public static readonly AuthorizePath = '/tenant-1/authorize?response_type=code&client_id=client-1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb'
        + '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=s&nonce=n';

    public host!: IdpHost;
    public ca = '';
    public appDir = '';

    public static async Run(body: (f: LoginFixture) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-host-login-'));
        const f = new LoginFixture();
        try
        {
            f.appDir = path.join(dir, 'app');
            fs.mkdirSync(path.join(f.appDir, 'assets'), { recursive: true });
            fs.writeFileSync(path.join(f.appDir, 'index.html'), LoginFixture.Index);
            fs.writeFileSync(path.join(f.appDir, 'assets', 'app.js'), LoginFixture.AssetText);
            fs.writeFileSync(path.join(f.appDir, 'assets', 'index-C5xRSLQ3.js'), LoginFixture.AssetText);
            fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside');
            const key = await IdpSigningKey.LoadOrCreate(path.join(dir, 'idp-signing.pem'));
            const ca = DevCa.EnsureAt(path.join(dir, 'ca'), 'localhost');
            const tls = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile });
            const realm = await IdpRealm.OpenFor(path.join(dir, 'realms'), LoginFixture.TenantId, 'T', randomBytes(32));
            await realm.SeedAccount(LoginFixture.Email, 'p-1', LoginFixture.Password, 'Owner');
            const clients = new IdpClientStore();
            await clients.Register(LoginFixture.TenantId, 'client-1', ['https://app.example/cb'], 'secret');
            f.host = new IdpHost('https://localhost', key, new IdpRealmSet([[LoginFixture.TenantId, realm]]), clients,
                new InMemoryAuthorizationCodeStore(), new IdpSsoSessionStore(), tls, true, undefined, undefined, new IdpLoginThrottle(), IdpLoginPage.Load(f.appDir));
            await f.host.Listen(0, '127.0.0.1');
            f.ca = fs.readFileSync(ca.caFile, 'utf8');
            await body(f);
        }
        finally
        {
            await f.host?.Close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    public Send(method: string, urlPath: string, form?: string): Promise<Reply>
    {
        const addr = this.host.Address();
        return new Promise<Reply>((resolve, reject) =>
        {
            const headers: Record<string, string> = form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' };
            const req = https.request({ host: 'localhost', port: addr.port, path: urlPath, method, ca: this.ca, headers }, res =>
            {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
            });
            req.on('error', reject);
            req.end(form);
        });
    }
}

test('GET /authorize serves the sign-in app with the ready flag, never cached and never framed', () => LoginFixture.Run(async f =>
{
    const r = await f.Send('GET', LoginFixture.AuthorizePath);
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), LoginFixture.Index);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['content-security-policy'], "frame-ancestors 'none'");
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
}));

test('a rejected sign-in serves the app flagged failed, echoing neither the email nor the password', () => LoginFixture.Run(async f =>
{
    const r = await f.Send('POST', LoginFixture.AuthorizePath, new URLSearchParams({ email: LoginFixture.Email, password: 'wrong-pw' }).toString());
    assert.equal(r.status, 200);
    const html = r.body.toString();
    assert.ok(html.includes('<meta name="pragmatic-login" content="failed">'));
    assert.ok(!html.includes('wrong-pw'));
    assert.ok(!html.includes(LoginFixture.Email));
}));

test('the app\'s form post signs in exactly as before: a redirect with a code to the registered callback', () => LoginFixture.Run(async f =>
{
    const r = await f.Send('POST', LoginFixture.AuthorizePath, new URLSearchParams({ email: LoginFixture.Email, password: LoginFixture.Password }).toString());
    assert.equal(r.status, 302);
    const location = new URL(String(r.headers['location']));
    assert.equal(location.origin + location.pathname, 'https://app.example/cb');
    assert.ok(location.searchParams.get('code'));
}));

test('/_login/ serves the app\'s assets and nothing else', () => LoginFixture.Run(async f =>
{
    const asset = await f.Send('GET', '/_login/assets/app.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.body.toString(), LoginFixture.AssetText);
    assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(asset.headers['x-content-type-options'], 'nosniff');
    assert.equal(asset.headers['cache-control'], 'public, max-age=3600');
    const hashed = await f.Send('GET', '/_login/assets/index-C5xRSLQ3.js');
    assert.equal(hashed.headers['cache-control'], 'public, max-age=31536000, immutable');
    for (const probe of ['/_login/assets/missing.js', '/_login/index.html', '/_login/%2e%2e/outside.txt', '/_login/..%2Foutside.txt', '/_login/'])
    {
        assert.equal((await f.Send('GET', probe)).status, 404, probe);
    }
    assert.equal((await f.Send('POST', '/_login/assets/app.js', '')).status, 404);
    // Served from memory: a file appearing after load is never served.
    fs.writeFileSync(path.join(f.appDir, 'assets', 'late.js'), LoginFixture.AssetText);
    assert.equal((await f.Send('GET', '/_login/assets/late.js')).status, 404);
}));
