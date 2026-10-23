import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { IdpMain } from '../idp-main.js';

class MainFixture
{
    public static readonly DirPrefix = 'idp-main-';
    public static readonly TenantId = 'tenant-1';
    public static readonly Localhost = 'localhost';
    public static readonly Loopback = '127.0.0.1';
    public static readonly BaseUrl = 'https://localhost';
    public static readonly Utf8 = 'utf8';
    public static readonly CaFile = 'ca.crt';
    public static readonly TlsDir = 'tls';

    public static Get(port: number, ca: string, urlPath: string): Promise<{ status: number; body: any }>
    {
        return new Promise((resolve, reject) =>
        {
            const req = https.get({ host: MainFixture.Localhost, port, path: urlPath, ca }, res =>
            {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString(MainFixture.Utf8)) }));
            });
            req.on('error', reject);
        });
    }
}

test('IsEntryPoint is false when imported', () =>
{
    assert.equal(IdpMain.IsEntryPoint(), false);
});

test('Compose requires a base url', async () =>
{
    await assert.rejects(IdpMain.Compose({}), /PRAGMATIC_IDP_BASE_URL/);
});

test('Compose binds HTTPS and serves discovery for a configured tenant', async () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
    const host = await IdpMain.Compose({
        PRAGMATIC_IDP_DATA: dir,
        PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl,
        PRAGMATIC_IDP_TENANTS: MainFixture.TenantId,
    });
    try
    {
        await host.Listen(0, MainFixture.Loopback);
        const ca = fs.readFileSync(path.join(dir, MainFixture.TlsDir, MainFixture.CaFile), MainFixture.Utf8);
        const r = await MainFixture.Get(host.Address().port, ca, `/${MainFixture.TenantId}/.well-known/openid-configuration`);
        assert.equal(r.status, 200);
        assert.deepEqual(Object.keys(r.body).sort(), ['authorization_endpoint', 'issuer', 'jwks_uri', 'token_endpoint']);
        assert.equal(r.body.issuer, `${MainFixture.BaseUrl}/${MainFixture.TenantId}`);
    }
    finally
    {
        await host.Close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
