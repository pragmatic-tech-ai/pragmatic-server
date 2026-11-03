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
import { IdpAdminEndpoint } from '../idp-admin-endpoint.js';

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
    public static readonly AdminToken = 'relay-admin-token';
    public static readonly EndUserIpHeader = 'x-pragmatic-end-user-ip';
    public static readonly PerAddress = 5;
    public static readonly PerAccount = 20;
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
            // The host rotates through RotatePasswordOf (it needs the principal to end its other SSO sessions).
            const original = realm.RotatePasswordOf.bind(realm);
            realm.RotatePasswordOf = async (e: string, c: string, n: string) =>
            {
                f.rotateCalls++;
                await new Promise(resolve => setTimeout(resolve, 50));
                return original(e, c, n);
            };
            const clients = new IdpClientStore();
            await clients.Register(ThrottleFixture.TenantId, ThrottleFixture.ClientId, [ThrottleFixture.RedirectUri], 'secret');
            const realms = new IdpRealmSet([[ThrottleFixture.TenantId, realm]]);
            const sso = new IdpSsoSessionStore();
            f.host = new IdpHost('https://localhost', key, realms, clients,
                new InMemoryAuthorizationCodeStore(), sso, tls, true, new IdpAdminEndpoint([ThrottleFixture.AdminToken], realms, clients, sso));
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

    public Post(urlPath: string, contentType: string, payload: string, extra: Record<string, string> = {}): Promise<Reply>
    {
        const addr = this.host.Address();
        return new Promise<Reply>((resolve, reject) =>
        {
            const req = https.request({ host: 'localhost', port: addr.port, path: urlPath, method: 'POST', ca: this.ca, headers: { 'content-type': contentType, ...extra } }, res =>
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

    /** A change relayed for end-user address `ip`, presenting `token` as the admin credential (null: none). */
    public RotateAs(current: string, ip: string, token: string | null = ThrottleFixture.AdminToken): Promise<Reply>
    {
        const headers: Record<string, string> = { [ThrottleFixture.EndUserIpHeader]: ip };
        if (token !== null)
        {
            headers.authorization = 'Bearer ' + token;
        }
        return this.Post(ThrottleFixture.PasswordPath, 'application/json',
            JSON.stringify({ email: ThrottleFixture.Email, currentPassword: current, newPassword: ThrottleFixture.Next }), headers);
    }

    public Login(password: string): Promise<Reply>
    {
        return this.Post(ThrottleFixture.AuthorizePath, 'application/x-www-form-urlencoded',
            new URLSearchParams({ email: ThrottleFixture.Email, password }).toString());
    }
}

test('rotation: 5 wrong current passwords lock; the 6th is 429 with Retry-After and RotatePassword is not called', () => ThrottleFixture.Run(async f =>
{
    for (let i = 0; i < ThrottleFixture.PerAddress; i++)
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
    assert.ok(f.rotateCalls <= ThrottleFixture.PerAddress, `RotatePassword reached ${f.rotateCalls} times`);
    assert.equal(replies.filter(r => r.status === 429).length, 8 - f.rotateCalls);
}));

test('rotation: a correct rotation clears the counter', () => ThrottleFixture.Run(async f =>
{
    await f.Rotate('nope');
    await f.Rotate('nope');
    assert.equal((await f.Rotate(ThrottleFixture.Old)).status, 200);
    for (let i = 0; i < ThrottleFixture.PerAddress; i++)
    {
        assert.equal((await f.Rotate('nope')).status, 401);
    }
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

test('separate buckets: failed password changes never lock login, and failed logins never lock a change', () => ThrottleFixture.Run(async f =>
{
    for (let i = 0; i < 5; i++)
    {
        await f.Rotate('nope');
    }
    assert.equal((await f.Rotate(ThrottleFixture.Old)).status, 429, 'the change bucket itself is locked');
    const login = await f.Login(ThrottleFixture.Old);
    assert.notEqual(login.status, 429, 'five failed changes do not block a login');
}));

test('separate buckets: failed logins lock login (429 with Retry-After) but not a password change', () => ThrottleFixture.Run(async f =>
{
    for (let i = 0; i < 3; i++)
    {
        await f.Login('bad');
    }
    const login = await f.Login(ThrottleFixture.Old);
    assert.equal(login.status, 429);
    assert.ok(Number(login.retryAfter) > 0);
    assert.equal(login.cacheControl, 'no-store');
    assert.equal((await f.Rotate(ThrottleFixture.Old)).status, 200);
}));

test('per address: 5 failures from address X lock X but not address Y (relayed with the admin credential)', () => ThrottleFixture.Run(async f =>
{
    for (let i = 0; i < ThrottleFixture.PerAddress; i++)
    {
        assert.equal((await f.RotateAs('nope', '203.0.113.1')).status, 401);
    }
    assert.equal((await f.RotateAs(ThrottleFixture.Old, '203.0.113.1')).status, 429);
    assert.equal((await f.RotateAs(ThrottleFixture.Old, '203.0.113.2')).status, 200);
}));

test('per account: 20 failures spread across addresses lock every address (distributed guessing is bounded)', () => ThrottleFixture.Run(async f =>
{
    for (let i = 0; i < ThrottleFixture.PerAccount; i++)
    {
        assert.equal((await f.RotateAs('nope', '198.51.100.' + String(i + 1))).status, 401);
    }
    const fresh = await f.RotateAs(ThrottleFixture.Old, '192.0.2.200');
    assert.equal(fresh.status, 429);
    assert.ok(Number(fresh.retryAfter) > 0);
}));

test('the end-user address header is ignored without a valid admin credential (the socket address is used)', () => ThrottleFixture.Run(async f =>
{
    for (let i = 0; i < ThrottleFixture.PerAddress; i++)
    {
        assert.equal((await f.RotateAs('nope', '203.0.113.' + String(i + 1), i % 2 === 0 ? null : 'not-the-token')).status, 401);
    }
    // Every attempt counted against the one socket address, whatever the header said.
    assert.equal((await f.RotateAs(ThrottleFixture.Old, '203.0.113.99', null)).status, 429);
    // With the credential the header is honoured: a fresh address is not locked.
    assert.equal((await f.RotateAs(ThrottleFixture.Old, '203.0.113.99')).status, 200);
}));
