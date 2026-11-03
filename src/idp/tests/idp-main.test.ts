import { after, test } from 'node:test';
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
    public static readonly LoginDirEnv = 'PRAGMATIC_IDP_LOGIN_DIR';
    public static readonly LoginIndex = '<html><head><meta name="pragmatic-login" content="ready"></head></html>';
    private static loginDir: string | undefined;

    /** Points the IdP at a minimal built sign-in app (CI runs these tests without building idp-login). */
    public static LoginEnv(): NodeJS.ProcessEnv
    {
        if (MainFixture.loginDir === undefined)
        {
            MainFixture.loginDir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
            fs.writeFileSync(path.join(MainFixture.loginDir, 'index.html'), MainFixture.LoginIndex);
        }
        return { [MainFixture.LoginDirEnv]: MainFixture.loginDir };
    }

    /** Removes the minimal sign-in app once every test has run. */
    public static RemoveLoginApp(): void
    {
        if (MainFixture.loginDir !== undefined)
        {
            fs.rmSync(MainFixture.loginDir, { recursive: true, force: true });
            MainFixture.loginDir = undefined;
        }
    }

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
        const host = await IdpMain.Compose({ ...MainFixture.LoginEnv(), ...env });
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

    /** Composes with the token file holding `content`, PUTs the admin realm path with `presented`, returns the status. */
    public static async StatusWithTokenFile(content: string, presented: string): Promise<number>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
        fs.mkdirSync(path.join(dir, MainFixture.SecretsDir), { recursive: true });
        fs.writeFileSync(path.join(dir, MainFixture.SecretsDir, MainFixture.AdminRef), content);
        const env: NodeJS.ProcessEnv = { PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl, PRAGMATIC_IDP_TENANTS: MainFixture.TenantId };
        env[MainFixture.AdminRefEnv] = MainFixture.AdminRef;
        const host = await IdpMain.Compose({ ...MainFixture.LoginEnv(), ...env });
        try
        {
            await host.Listen(0, MainFixture.Loopback);
            const ca = fs.readFileSync(path.join(dir, MainFixture.TlsDir, MainFixture.CaFile), MainFixture.Utf8);
            return await MainFixture.Put(host.Address().port, ca, MainFixture.AdminRealmPath, presented);
        }
        finally
        {
            await host.Close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    public static readonly ClientBody = '{"clientId":"durable-client","redirectUris":["https://app.example/cb"],"secret":"durable-client-secret-xyz"}';
    public static readonly ClientsPath = '/_admin/realms/tenant-1/clients';
    public static readonly ClientPath = '/_admin/realms/tenant-1/clients/durable-client';
    public static readonly AuthorizePath = '/tenant-1/authorize?response_type=code&client_id=durable-client&redirect_uri=https%3A%2F%2Fapp.example%2Fcb'
        + '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=s&nonce=n';

    /** An admin request with a JSON body; returns the status. */
    public static Send(port: number, ca: string, method: string, urlPath: string, body: string): Promise<number>
    {
        return new Promise((resolve, reject) =>
        {
            const req = https.request({ host: MainFixture.Localhost, port, path: urlPath, ca, method, headers: { authorization: 'Bearer ' + MainFixture.AdminToken, 'content-type': 'application/json' } }, res =>
            {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
            });
            req.on('error', reject);
            req.end(body);
        });
    }

    /** A plain GET; returns only the status. */
    public static Status(port: number, ca: string, urlPath: string): Promise<number>
    {
        return new Promise((resolve, reject) =>
        {
            const req = https.get({ host: MainFixture.Localhost, port, path: urlPath, ca }, res =>
            {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
            });
            req.on('error', reject);
        });
    }

    /** Composes an admin-enabled IdP on `dir` with NO PRAGMATIC_IDP_TENANTS, runs `body` against it, then closes it. */
    public static async WithIdp(dir: string, body: (port: number, ca: string) => Promise<void>): Promise<void>
    {
        const host = await IdpMain.Compose({ ...MainFixture.LoginEnv(), PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl, [MainFixture.AdminRefEnv]: MainFixture.AdminRef });
        try
        {
            await host.Listen(0, MainFixture.Loopback);
            await body(host.Address().port, fs.readFileSync(path.join(dir, MainFixture.TlsDir, MainFixture.CaFile), MainFixture.Utf8));
        }
        finally
        {
            await host.Close();
        }
    }

    /** A data dir holding the admin token file. */
    public static AdminDataDir(): string
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
        fs.mkdirSync(path.join(dir, MainFixture.SecretsDir), { recursive: true });
        fs.writeFileSync(path.join(dir, MainFixture.SecretsDir, MainFixture.AdminRef), MainFixture.AdminToken + '\n');
        return dir;
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

after(() => MainFixture.RemoveLoginApp());

test('IsEntryPoint is false when imported', () =>
{
    assert.equal(IdpMain.IsEntryPoint(), false);
});

test('Compose requires a base url', async () =>
{
    await assert.rejects(IdpMain.Compose({ ...MainFixture.LoginEnv() }), /PRAGMATIC_IDP_BASE_URL/);
});

test('Compose binds HTTPS and serves discovery for a configured tenant', async () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
    const host = await IdpMain.Compose({
        ...MainFixture.LoginEnv(),
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
        ...MainFixture.LoginEnv(),
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
        await assert.rejects(IdpMain.Compose({ ...MainFixture.LoginEnv(), PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl, PRAGMATIC_IDP_INTERNAL_URL: 'http://idp.hive.svc' }), /PRAGMATIC_IDP_INTERNAL_URL.*https/);
    }
    finally
    {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Compose refuses to start without the built sign-in app', async () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
    const emptyApp = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
    try
    {
        await assert.rejects(IdpMain.Compose({ PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl, [MainFixture.LoginDirEnv]: emptyApp }), /not built/);
    }
    finally
    {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(emptyApp, { recursive: true, force: true });
    }
});

test('Compose rejects a garbage or http base url with a clear message', async () =>
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), MainFixture.DirPrefix));
    try
    {
        await assert.rejects(IdpMain.Compose({ ...MainFixture.LoginEnv(), PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: 'not a url' }), /PRAGMATIC_IDP_BASE_URL.*https/);
        await assert.rejects(IdpMain.Compose({ ...MainFixture.LoginEnv(), PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: 'http://localhost' }), /PRAGMATIC_IDP_BASE_URL.*https/);
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
        await IdpMain.Compose({ ...MainFixture.LoginEnv(), ...env });
        const master = fs.readFileSync(path.join(dir, 'master.key'));
        const signing = fs.readFileSync(path.join(dir, 'signing-key.pem'));
        await IdpMain.Compose({ ...MainFixture.LoginEnv(), ...env });
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
    const host = await IdpMain.Compose({ ...MainFixture.LoginEnv(), PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl, PRAGMATIC_IDP_TENANTS: MainFixture.TenantId, PRAGMATIC_IDP_ADMIN_TOKEN_REF: MainFixture.AdminRef });
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
    const host = await IdpMain.Compose({ ...MainFixture.LoginEnv(), PRAGMATIC_IDP_DATA: dir, PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl, PRAGMATIC_IDP_TENANTS: MainFixture.TenantId, PRAGMATIC_IDP_ADMIN_TOKEN_REF: '../something' });
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

test('a multi-line admin-token ref authenticates every member and rejects a non-member', async () =>
{
    const content = 'old-token-aaa\n\n  new-token-bbb  \r\n';
    assert.equal(await MainFixture.StatusWithTokenFile(content, 'old-token-aaa'), 200);
    assert.equal(await MainFixture.StatusWithTokenFile(content, 'new-token-bbb'), 200);
    assert.equal(await MainFixture.StatusWithTokenFile(content, 'other-token-ccc'), 401);
});

test('a single-line admin-token ref still works', async () =>
{
    assert.equal(await MainFixture.StatusWithTokenFile('only-token-ddd', 'only-token-ddd'), 200);
});

test('a realm and a client created through the admin API survive a restart without PRAGMATIC_IDP_TENANTS', async () =>
{
    const dir = MainFixture.AdminDataDir();
    try
    {
        await MainFixture.WithIdp(dir, async (port, ca) =>
        {
            assert.equal(await MainFixture.Send(port, ca, 'PUT', MainFixture.AdminRealmPath, MainFixture.DisplayBody), 200);
            assert.equal(await MainFixture.Send(port, ca, 'POST', MainFixture.ClientsPath, MainFixture.ClientBody), 200);
            assert.equal(await MainFixture.Status(port, ca, MainFixture.AuthorizePath), 200);
        });
        await MainFixture.WithIdp(dir, async (port, ca) =>
        {
            assert.equal((await MainFixture.Get(port, ca, `/${MainFixture.TenantId}/.well-known/openid-configuration`)).status, 200);
            assert.equal(await MainFixture.Status(port, ca, MainFixture.AuthorizePath), 200);
        });
    }
    finally
    {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a client deleted through the admin API stays deleted after a restart', async () =>
{
    const dir = MainFixture.AdminDataDir();
    try
    {
        await MainFixture.WithIdp(dir, async (port, ca) =>
        {
            assert.equal(await MainFixture.Send(port, ca, 'PUT', MainFixture.AdminRealmPath, MainFixture.DisplayBody), 200);
            assert.equal(await MainFixture.Send(port, ca, 'POST', MainFixture.ClientsPath, MainFixture.ClientBody), 200);
            assert.equal(await MainFixture.Send(port, ca, 'DELETE', MainFixture.ClientPath, ''), 200);
        });
        await MainFixture.WithIdp(dir, async (port, ca) =>
        {
            assert.notEqual(await MainFixture.Status(port, ca, MainFixture.AuthorizePath), 200);
        });
    }
    finally
    {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
