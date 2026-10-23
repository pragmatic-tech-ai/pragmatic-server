import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { DevCa, IdpTlsMaterial } from '../dev-ca.js';
import { IdpAdminEndpoint } from '../idp-admin-endpoint.js';
import { IdpClientStore } from '../idp-client-store.js';
import { IdpHost, IdpRealmSet } from '../idp-host.js';
import { IdpRealm } from '../idp-realm.js';
import { IdpSigningKey } from '../idp-signing-key.js';
import { IdpSsoSessionStore } from '../idp-sso-session.js';
import { InMemoryAuthorizationCodeStore } from '../authorization-code-store.js';

interface HttpsReply
{
    status: number;
    cacheControl: string | undefined;
}

class AdminFixture
{
    public static readonly DirPrefix = 'idp-host-admin-';
    public static readonly KeyFileName = 'idp-signing.pem';
    public static readonly CaDirName = 'ca';
    public static readonly RealmDirName = 'realms';
    public static readonly BaseUrl = 'https://localhost';
    public static readonly Loopback = '127.0.0.1';
    public static readonly Localhost = 'localhost';
    public static readonly Utf8 = 'utf8';
    public static readonly Token = 'admin-token-for-tests';
    public static readonly BearerPrefix = 'Bearer ';
    public static readonly AuthorizationHeader = 'authorization';
    public static readonly ContentTypeHeader = 'content-type';
    public static readonly CacheControlHeader = 'cache-control';
    public static readonly JsonType = 'application/json';
    public static readonly RealmPath = '/_admin/realms/tenant-1';
    public static readonly UnconfiguredPath = '/_admin/realms/x';
    public static readonly AccountsPath = '/_admin/realms/tenant-1/accounts';
    public static readonly DisplayBody = '{"displayName":"Tenant One"}';
    public static readonly NotJson = 'not json';
    public static readonly OversizeChars = 20000;
    public static readonly NoStore = 'no-store';

    public static async WithHost(withAdmin: boolean, body: (host: IdpHost, caPem: string) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), AdminFixture.DirPrefix));
        let host: IdpHost | undefined;
        try
        {
            const key = await IdpSigningKey.LoadOrCreate(path.join(dir, AdminFixture.KeyFileName));
            const ca = DevCa.EnsureAt(path.join(dir, AdminFixture.CaDirName), AdminFixture.Localhost);
            const tls = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile });
            const realmsDir = path.join(dir, AdminFixture.RealmDirName);
            const realms = new IdpRealmSet([], (tenantId, displayName) => IdpRealm.OpenFor(realmsDir, tenantId, displayName, randomBytes(32)));
            const clients = new IdpClientStore();
            const admin = withAdmin ? new IdpAdminEndpoint(AdminFixture.Token, realms, clients) : undefined;
            host = new IdpHost(AdminFixture.BaseUrl, key, realms, clients, new InMemoryAuthorizationCodeStore(), new IdpSsoSessionStore(), tls, true, admin);
            await host.Listen(0, AdminFixture.Loopback);
            await body(host, fs.readFileSync(ca.caFile, AdminFixture.Utf8));
        }
        finally
        {
            if (host !== undefined)
            {
                await host.Close();
            }
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    public static Send(host: IdpHost, caPem: string, method: string, urlPath: string, payload: string): Promise<HttpsReply>
    {
        const addr = host.Address();
        return new Promise<HttpsReply>((resolve, reject) =>
        {
            const req = https.request({
                host: AdminFixture.Localhost, port: addr.port, path: urlPath, method, ca: caPem,
                headers: {
                    [AdminFixture.AuthorizationHeader]: AdminFixture.BearerPrefix + AdminFixture.Token,
                    [AdminFixture.ContentTypeHeader]: AdminFixture.JsonType
                }
            }, res =>
            {
                res.resume();
                res.on('end', () => resolve({ status: res.statusCode ?? 0, cacheControl: res.headers[AdminFixture.CacheControlHeader] }));
            });
            req.on('error', reject);
            req.end(payload);
        });
    }
}

test('admin routes are reachable over https and carry Cache-Control no-store', async () =>
{
    await AdminFixture.WithHost(true, async (host, ca) =>
    {
        const r = await AdminFixture.Send(host, ca, 'PUT', AdminFixture.RealmPath, AdminFixture.DisplayBody);
        assert.equal(r.status, 200);
        assert.equal(r.cacheControl, AdminFixture.NoStore);
    });
});

test('the _admin namespace is 404 when no admin endpoint is configured', async () =>
{
    await AdminFixture.WithHost(false, async (host, ca) =>
    {
        const r = await AdminFixture.Send(host, ca, 'PUT', AdminFixture.UnconfiguredPath, AdminFixture.DisplayBody);
        assert.equal(r.status, 404);
    });
});

test('an oversized admin body is 413', async () =>
{
    await AdminFixture.WithHost(true, async (host, ca) =>
    {
        const r = await AdminFixture.Send(host, ca, 'POST', AdminFixture.AccountsPath, 'x'.repeat(AdminFixture.OversizeChars));
        assert.equal(r.status, 413);
    });
});

test('an invalid-json admin body is 400', async () =>
{
    await AdminFixture.WithHost(true, async (host, ca) =>
    {
        const r = await AdminFixture.Send(host, ca, 'POST', AdminFixture.AccountsPath, AdminFixture.NotJson);
        assert.equal(r.status, 400);
    });
});
