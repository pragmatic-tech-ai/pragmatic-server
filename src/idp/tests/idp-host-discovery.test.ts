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

interface HttpsReply
{
    status: number;
    body: any;
}

class HostFixture
{
    public static readonly DirPrefix = 'idp-host-';
    public static readonly TenantId = 'tenant-1';
    public static readonly DisplayName = 'Tenant One';
    public static readonly BaseUrl = 'https://localhost';
    public static readonly Loopback = '127.0.0.1';
    public static readonly KeyFileName = 'idp-signing.pem';
    public static readonly RealmDirName = 'realms';
    public static readonly Localhost = 'localhost';
    public static readonly CaDirName = 'ca';
    public static readonly Utf8 = 'utf8';

    public static async WithHost(body: (host: IdpHost, key: IdpSigningKey, caPem: string) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), HostFixture.DirPrefix));
        let host: IdpHost | undefined;
        try
        {
            const key = await IdpSigningKey.LoadOrCreate(path.join(dir, HostFixture.KeyFileName));
            const realm = await IdpRealm.OpenFor(path.join(dir, HostFixture.RealmDirName), HostFixture.TenantId, HostFixture.DisplayName, randomBytes(32));
            const ca = DevCa.EnsureAt(path.join(dir, HostFixture.CaDirName), HostFixture.Localhost);
            const tls = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile });
            host = HostFixture.Build(HostFixture.BaseUrl, key, new IdpRealmSet([[HostFixture.TenantId, realm]]), tls);
            await host.Listen(0, HostFixture.Loopback);
            await body(host, key, fs.readFileSync(ca.caFile, HostFixture.Utf8));
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

    public static Build(baseUrl: string, key: IdpSigningKey, realms: IdpRealmSet, tls: { key: Buffer; cert: Buffer }): IdpHost
    {
        return new IdpHost(baseUrl, key, realms, new IdpClientStore(), new InMemoryAuthorizationCodeStore(), new IdpSsoSessionStore(), tls, true);
    }

    public static Get(host: IdpHost, caPem: string, urlPath: string): Promise<HttpsReply>
    {
        const addr = host.Address();
        return new Promise<HttpsReply>((resolve, reject) =>
        {
            const req = https.get({ host: HostFixture.Localhost, port: addr.port, path: urlPath, ca: caPem }, res =>
            {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString(HostFixture.Utf8)) }));
            });
            req.on('error', reject);
        });
    }
}

test('discovery returns exactly the four https fields for the tenant', async () =>
{
    await HostFixture.WithHost(async (host, _key, ca) =>
    {
        const r = await HostFixture.Get(host, ca, `/${HostFixture.TenantId}/.well-known/openid-configuration`);
        assert.equal(r.status, 200);
        assert.deepEqual(Object.keys(r.body).sort(), ['authorization_endpoint', 'issuer', 'jwks_uri', 'token_endpoint']);
        for (const v of Object.values(r.body) as string[])
        {
            assert.ok(v.startsWith('https://'));
            assert.ok(v.includes(`/${HostFixture.TenantId}`));
        }
        assert.equal(r.body.issuer, `${HostFixture.BaseUrl}/${HostFixture.TenantId}`);
        assert.equal(r.body.authorization_endpoint, `${r.body.issuer}/authorize`);
        assert.equal(r.body.token_endpoint, `${r.body.issuer}/token`);
        assert.equal(r.body.jwks_uri, `${r.body.issuer}/jwks`);
    });
});

test('jwks serves the signing public key', async () =>
{
    await HostFixture.WithHost(async (host, key, ca) =>
    {
        const r = await HostFixture.Get(host, ca, `/${HostFixture.TenantId}/jwks`);
        assert.equal(r.status, 200);
        assert.equal(r.body.keys[0].kid, key.Kid());
    });
});

test('an unknown tenant discovery path is 404', async () =>
{
    await HostFixture.WithHost(async (host, _key, ca) =>
    {
        const unknownTenant = await HostFixture.Get(host, ca, '/nope/.well-known/openid-configuration');
        assert.equal(unknownTenant.status, 404);
        const unknownPath = await HostFixture.Get(host, ca, `/${HostFixture.TenantId}/bogus`);
        assert.equal(unknownPath.status, 404);
        assert.deepEqual(unknownPath.body, unknownTenant.body);
    });
});

test('constructor rejects a non-https baseUrl', async () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), HostFixture.DirPrefix));
    try
    {
        const key = await IdpSigningKey.LoadOrCreate(path.join(dir, HostFixture.KeyFileName));
        const tls = { key: Buffer.alloc(0), cert: Buffer.alloc(0) };
        assert.throws(() => HostFixture.Build('http://localhost', key, new IdpRealmSet([]), tls));
    }
    finally
    {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
