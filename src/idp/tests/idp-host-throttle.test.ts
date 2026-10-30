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
import { IdpRealm } from '../idp-realm.js';
import { IdpSigningKey } from '../idp-signing-key.js';
import { IdpSsoSessionStore } from '../idp-sso-session.js';
import { InMemoryAuthorizationCodeStore } from '../authorization-code-store.js';

interface Reply
{
    status: number;
    retryAfter: string | undefined;
    cacheControl: string | undefined;
    text: string;
}

class ThrottleFixture
{
    public static readonly TenantId = 'tenant-1';
    public static readonly ClientId = 'client-1';
    public static readonly RedirectUri = 'https://app.example/cb';
    public static readonly Email = 'o@t';
    public static readonly Old = 'old-pw-Aa1';
    public static readonly Next = 'new-pw-Bb2';
    public static readonly PasswordPath = '/tenant-1/password';
    public static readonly AuthorizePath = '/tenant-1/authorize?response_type=code&client_id=client-1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb'
        + '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=s&nonce=n';

    public rotateCalls = 0;
    public host!: IdpHost;
    public ca = '';

    public static async Run(body: (f: ThrottleFixture) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-host-throttle-'));
        const f = new ThrottleFixture();
        try
        {
            const key = await IdpSigningKey.LoadOrCreate(path.join(dir, 'idp-signing.pem'));
            const ca = DevCa.EnsureAt(path.join(dir, 'ca'), 'localhost');
            const tls = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile });
            const realm = await IdpRealm.OpenFor(path.join(dir, 'realms'), ThrottleFixture.TenantId, 'T', randomBytes(32));
            await realm.SeedAccount(ThrottleFixture.Email, 'p-1', ThrottleFixture.Old, 'Owner');
            const original = realm.RotatePassword.bind(realm);
            realm.RotatePassword = async (e: string, c: string, n: string) =>
            {
                f.rotateCalls++;
                await new Promise(resolve => setTimeout(resolve, 50));
                return original(e, c, n);
            };
            const clients = new IdpClientStore();
            await clients.Register(ThrottleFixture.TenantId, ThrottleFixture.ClientId, [ThrottleFixture.RedirectUri], 'secret');
            f.host = new IdpHost('https://localhost', key, new IdpRealmSet([[ThrottleFixture.TenantId, realm]]), clients,
                new InMemoryAuthorizationCodeStore(), new IdpSsoSessionStore(), tls, true);
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

    public Post(urlPath: string, contentType: string, payload: string): Promise<Reply>
    {
        const addr = this.host.Address();
        return new Promise<Reply>((resolve, reject) =>
        {
            const req = https.request({ host: 'localhost', port: addr.port, path: urlPath, method: 'POST', ca: this.ca, headers: { 'content-type': contentType } }, res =>
            {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'], cacheControl: res.headers['cache-control'], text: Buffer.concat(chunks).toString('utf8') }));
            });
            req.on('error', reject);
            req.end(payload);
        });
    }

    public Rotate(current: string): Promise<Reply>
    {
        return this.Post(ThrottleFixture.PasswordPath, 'application/json',
            JSON.stringify({ email: ThrottleFixture.Email, currentPassword: current, newPassword: ThrottleFixture.Next }));
    }

    public Login(password: string): Promise<Reply>
    {
        return this.Post(ThrottleFixture.AuthorizePath, 'application/x-www-form-urlencoded',
            new URLSearchParams({ email: ThrottleFixture.Email, password }).toString());
    }
}

test('rotation: 3 wrong current passwords lock; the 4th is 429 with Retry-After and RotatePassword is not called', () => ThrottleFixture.Run(async f =>
{
    for (let i = 0; i < 3; i++)
    {
        assert.equal((await f.Rotate('nope')).status, 401);
    }
    const calls = f.rotateCalls;
    const locked = await f.Rotate(ThrottleFixture.Old);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.retryAfter) > 0);
    assert.equal(f.rotateCalls, calls);
    assert.ok(!locked.text.includes(ThrottleFixture.Old));
}));

test('rotation: concurrent wrong guesses for one key: at most maxAttempts reach RotatePassword (count-at-gate)', () => ThrottleFixture.Run(async f =>
{
    const replies = await Promise.all(Array.from({ length: 8 }, () => f.Rotate('nope')));
    assert.ok(f.rotateCalls <= 3, `RotatePassword reached ${f.rotateCalls} times`);
    assert.equal(replies.filter(r => r.status === 429).length, 8 - f.rotateCalls);
}));

test('rotation: a correct rotation clears the counter', () => ThrottleFixture.Run(async f =>
{
    await f.Rotate('nope');
    await f.Rotate('nope');
    assert.equal((await f.Rotate(ThrottleFixture.Old)).status, 200);
    assert.equal((await f.Rotate('nope')).status, 401);
    assert.equal((await f.Rotate('nope')).status, 401);
    assert.equal((await f.Rotate('nope')).status, 401);
    assert.equal((await f.Rotate('nope')).status, 429);
}));

test('rotation: malformed bodies are not counted toward the lock', () => ThrottleFixture.Run(async f =>
{
    const bodies = [
        { email: ThrottleFixture.Email, currentPassword: ThrottleFixture.Old },
        { email: '', currentPassword: ThrottleFixture.Old, newPassword: ThrottleFixture.Next },
        { email: ThrottleFixture.Email, currentPassword: '', newPassword: ThrottleFixture.Next },
        { email: ThrottleFixture.Email, currentPassword: ThrottleFixture.Old, newPassword: '' }
    ];
    for (let i = 0; i < 2; i++)
    {
        for (const b of bodies)
        {
            assert.equal((await f.Post(ThrottleFixture.PasswordPath, 'application/json', JSON.stringify(b))).status, 400);
        }
    }
    assert.equal((await f.Rotate(ThrottleFixture.Old)).status, 200);
}));

test('shared counter: failed rotation and failed logins lock the same key; login 429 carries Retry-After', () => ThrottleFixture.Run(async f =>
{
    assert.equal((await f.Rotate('nope')).status, 401);
    assert.equal((await f.Login('bad')).status, 200);
    assert.equal((await f.Login('bad')).status, 200);
    const login = await f.Login(ThrottleFixture.Old);
    assert.equal(login.status, 429);
    assert.ok(Number(login.retryAfter) > 0);
    assert.equal(login.cacheControl, 'no-store');
    assert.equal((await f.Rotate(ThrottleFixture.Old)).status, 429);
}));
