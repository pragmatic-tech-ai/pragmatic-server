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
    body: unknown;
}

class HealthFixture
{
    public static readonly DirPrefix = 'idp-health-';
    public static readonly TenantId = 'tenant-1';
    public static readonly DisplayName = 'Tenant One';
    public static readonly BaseUrl = 'https://localhost';
    public static readonly Loopback = '127.0.0.1';
    public static readonly KeyFileName = 'idp-signing.pem';
    public static readonly RealmDirName = 'realms';
    public static readonly Localhost = 'localhost';
    public static readonly CaDirName = 'ca';
    public static readonly Utf8 = 'utf8';
    public static readonly HealthPath = '/healthz';
    public static readonly BogusPath = '/no-such-route';

    /** Serves a host with an EMPTY realm set (no tenant or realm configured). */
    public static async WithRealmlessHost(body: (host: IdpHost, caPem: string) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), HealthFixture.DirPrefix));
        let host: IdpHost | undefined;
        try
        {
            const key = await IdpSigningKey.LoadOrCreate(path.join(dir, HealthFixture.KeyFileName));
            const ca = DevCa.EnsureAt(path.join(dir, HealthFixture.CaDirName), HealthFixture.Localhost);
            const tls = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile });
            host = new IdpHost(HealthFixture.BaseUrl, key, new IdpRealmSet([]), new IdpClientStore(), new InMemoryAuthorizationCodeStore(), new IdpSsoSessionStore(), tls, true);
            await host.Listen(0, HealthFixture.Loopback);
            await body(host, fs.readFileSync(ca.caFile, HealthFixture.Utf8));
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

    public static Get(host: IdpHost, caPem: string, urlPath: string): Promise<HttpsReply>
    {
        const addr = host.Address();
        return new Promise<HttpsReply>((resolve, reject) =>
        {
            const req = https.get({ host: HealthFixture.Localhost, port: addr.port, path: urlPath, ca: caPem }, res =>
            {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString(HealthFixture.Utf8)) }));
            });
            req.on('error', reject);
        });
    }
}

test('healthz returns 200 {status:"ok"} with no realm configured', async () =>
{
    await HealthFixture.WithRealmlessHost(async (host, ca) =>
    {
        const r = await HealthFixture.Get(host, ca, HealthFixture.HealthPath);
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { status: 'ok' });
    });
});

test('a bogus path still 404s on a realmless host', async () =>
{
    await HealthFixture.WithRealmlessHost(async (host, ca) =>
    {
        const r = await HealthFixture.Get(host, ca, HealthFixture.BogusPath);
        assert.equal(r.status, 404);
    });
});
