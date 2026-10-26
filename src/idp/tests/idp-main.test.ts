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
    public static readonly InternalBaseUrl = 'https://idp.hive.svc.cluster.local:8443';

    public static readonly AdminRef = 'admin-token';
    public static readonly AdminToken = 'main-admin-token-xyz';
    public static readonly SecretsDir = 'secrets';
    public static readonly AdminRefEnv = 'PRAGMATIC_IDP_ADMIN_TOKEN_REF';
    public static readonly AdminRealmPath = '/_admin/realms/tenant-1';
    public static readonly DisplayBody = '{"displayName":"Tenant One"}';

    public static Put(port: number, ca: string, urlPath: string, token: string): Promise<number>
    {
        return new Promise((resolve, reject) =>
        {
            const req = https.request({ host: MainFixture.Localhost, port, path: urlPath, ca, method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, res =>
            {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
            });
            req.on('error', reject);
            req.end(MainFixture.DisplayBody);
        });
    }

    /** Composes with optional admin ref (and optional token file), PUTs the admin realm path, returns the status. */
    public static async AdminStatus(withRef: boolean, writeFile: boolean): Promise<number>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
        const env: NodeJS.ProcessEnv = { PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl, PRAGMATIC_IDP_TENANTS: MainFixture.TenantId };
        if (writeFile)
        {
            fs.mkdirSync(path.join(dir, MainFixture.SecretsDir), { recursive: true });
            fs.writeFileSync(path.join(dir, MainFixture.SecretsDir, MainFixture.AdminRef), MainFixture.AdminToken + '\n');
        }
        if (withRef)
        {
            env[MainFixture.AdminRefEnv] = MainFixture.AdminRef;
        }
        const host = await IdpMain.Compose(env);
        try
        {
            await host.Listen(0, MainFixture.Loopback);
            const ca = fs.readFileSync(path.join(dir, MainFixture.TlsDir, MainFixture.CaFile), MainFixture.Utf8);
            return await MainFixture.Put(host.Address().port, ca, MainFixture.AdminRealmPath, MainFixture.AdminToken);
        }
        finally
        {
            await host.Close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

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

test('Compose with PRAGMATIC_IDP_INTERNAL_URL serves split-host discovery (token/jwks on the internal base)', async () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
    const host = await IdpMain.Compose({
        PRAGMATIC_IDP_DATA: dir,
        PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl,
        PRAGMATIC_IDP_INTERNAL_URL: MainFixture.InternalBaseUrl,
        PRAGMATIC_IDP_TENANTS: MainFixture.TenantId,
    });
    try
    {
        await host.Listen(0, MainFixture.Loopback);
        const ca = fs.readFileSync(path.join(dir, MainFixture.TlsDir, MainFixture.CaFile), MainFixture.Utf8);
        const r = await MainFixture.Get(host.Address().port, ca, `/${MainFixture.TenantId}/.well-known/openid-configuration`);
        const issuer = `${MainFixture.BaseUrl}/${MainFixture.TenantId}`;
        const internal = `${MainFixture.InternalBaseUrl}/${MainFixture.TenantId}`;
        assert.equal(r.body.issuer, issuer);
        assert.equal(r.body.authorization_endpoint, `${issuer}/authorize`);
        assert.equal(r.body.token_endpoint, `${internal}/token`);
        assert.equal(r.body.jwks_uri, `${internal}/jwks`);
    }
    finally
    {
        await host.Close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Compose rejects a non-https PRAGMATIC_IDP_INTERNAL_URL with a clear message', async () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
    try
    {
        await assert.rejects(IdpMain.Compose({ PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl, PRAGMATIC_IDP_INTERNAL_URL: 'http://idp.hive.svc' }), /PRAGMATIC_IDP_INTERNAL_URL.*https/);
    }
    finally
    {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Compose rejects a garbage or http base url with a clear message', async () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
    try
    {
        await assert.rejects(IdpMain.Compose({ PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: 'not a url' }), /PRAGMATIC_IDP_BASE_URL.*https/);
        await assert.rejects(IdpMain.Compose({ PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: 'http://localhost' }), /PRAGMATIC_IDP_BASE_URL.*https/);
    }
    finally
    {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Compose persists master.key and signing-key.pem and reuses them', async () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
    const env = { PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl };
    try
    {
        await IdpMain.Compose(env);
        const master = fs.readFileSync(path.join(dir, 'master.key'));
        const signing = fs.readFileSync(path.join(dir, 'signing-key.pem'));
        await IdpMain.Compose(env);
        assert.deepEqual(fs.readFileSync(path.join(dir, 'master.key')), master);
        assert.deepEqual(fs.readFileSync(path.join(dir, 'signing-key.pem')), signing);
    }
    finally
    {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Compose with an admin-token ref file present enables the _admin namespace', async () =>
{
    assert.equal(await MainFixture.AdminStatus(true, true), 200);
});

test('Compose without the admin-token ref keeps the _admin namespace at 404', async () =>
{
    assert.equal(await MainFixture.AdminStatus(false, true), 404);
});

test('Compose with the ref set but the secrets file missing starts with admin disabled (404, no throw)', async () =>
{
    assert.equal(await MainFixture.AdminStatus(true, false), 404);
});

test('Compose with an empty admin token file keeps admin disabled', async () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
    fs.mkdirSync(path.join(dir, MainFixture.SecretsDir), { recursive: true });
    fs.writeFileSync(path.join(dir, MainFixture.SecretsDir, MainFixture.AdminRef), '  \n');
    const host = await IdpMain.Compose({ PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl, PRAGMATIC_IDP_TENANTS: MainFixture.TenantId, PRAGMATIC_IDP_ADMIN_TOKEN_REF: MainFixture.AdminRef });
    try
    {
        await host.Listen(0, MainFixture.Loopback);
        const ca = fs.readFileSync(path.join(dir, MainFixture.TlsDir, MainFixture.CaFile), MainFixture.Utf8);
        assert.equal(await MainFixture.Put(host.Address().port, ca, MainFixture.AdminRealmPath, ''), 404);
    }
    finally
    {
        await host.Close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Compose with a traversal admin-token ref keeps admin disabled (404)', async () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
    fs.mkdirSync(path.join(dir, MainFixture.SecretsDir), { recursive: true });
    fs.writeFileSync(path.join(dir, 'something'), MainFixture.AdminToken);
    const host = await IdpMain.Compose({ PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl, PRAGMATIC_IDP_TENANTS: MainFixture.TenantId, PRAGMATIC_IDP_ADMIN_TOKEN_REF: '../something' });
    try
    {
        await host.Listen(0, MainFixture.Loopback);
        const ca = fs.readFileSync(path.join(dir, MainFixture.TlsDir, MainFixture.CaFile), MainFixture.Utf8);
        assert.equal(await MainFixture.Put(host.Address().port, ca, MainFixture.AdminRealmPath, MainFixture.AdminToken), 404);
    }
    finally
    {
        await host.Close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
