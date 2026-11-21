import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DevCa, IdpTlsMaterial } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc';
import type { IdpRealmSet } from '../../../src/idp/idp-realm-set.js';
import type { SqlIdpClientStore } from '../../../src/idp/sql-idp-client-store.js';
import { TenantIdpTestHost } from '../../../src/idp/tests/tenant-idp-test-host.js';
import { IdpAdminClient, IdpAdminError, IdpAdminTransportError } from '@pragmatic-tech-ai/pragmatic-tenant-plane';

class ClientFixture
{
    public static readonly DirPrefix = 'idp-admin-client-';
    public static readonly KeyFileName = 'idp-signing.pem';
    public static readonly CaDirName = 'ca';
    public static readonly RealmDirName = 'realms';
    public static readonly BaseUrl = 'https://localhost';
    public static readonly Loopback = '127.0.0.1';
    public static readonly Localhost = 'localhost';
    public static readonly Utf8 = 'utf8';
    public static readonly Token = TenantIdpTestHost.AdminToken;
    public static readonly BadToken = 'wrong-token';
    public static readonly TenantId = 'tenant-1';
    public static readonly DisplayName = 'Tenant One';
    public static readonly Email = 'ann@example.test';
    public static readonly PrincipalId = 'p-ann';
    public static readonly Password = 'pw-very-secret-123';
    public static readonly ClientId = 'app-1';
    public static readonly Secret = 'client-secret-xyz-789';
    public static readonly Redirect = 'https://app.example.test/cb';
    public static readonly HttpsScheme = 'https://';
    public static readonly Colon = ':';
    public static readonly Unauthorized = 401;
    public static readonly Ann = 'Ann';

    public static async WithHost(body: (host: TenantIdpTestHost, realms: IdpRealmSet, clients: SqlIdpClientStore, caPem: string) => Promise<void>): Promise<void>
    {
        const host = await TenantIdpTestHost.Start();
        try
        {
            await body(host, host.Service.Realms, host.Service.Stores.Clients, host.Ca);
        }
        finally
        {
            await host.Close();
        }
    }

    public static UrlOf(host: TenantIdpTestHost): string
    {
        return host.BaseUrl;
    }
}

test('EnsureRealm, SeedAccount, RegisterClient round-trip over https', async () =>
{
    await ClientFixture.WithHost(async (host, realms, clients, ca) =>
    {
        const client = new IdpAdminClient({ baseUrl: ClientFixture.UrlOf(host), adminToken: ClientFixture.Token, ca });
        await client.EnsureRealm(ClientFixture.TenantId, ClientFixture.DisplayName);
        await client.SeedAccount(ClientFixture.TenantId, { email: ClientFixture.Email, principalId: ClientFixture.PrincipalId, displayName: ClientFixture.Ann, password: ClientFixture.Password });
        await client.RegisterClient(ClientFixture.TenantId, { clientId: ClientFixture.ClientId, redirectUris: [ClientFixture.Redirect], secret: ClientFixture.Secret });

        const realm = realms.For(ClientFixture.TenantId);
        assert.ok(realm !== undefined);
        assert.ok(await realm.AuthenticatePassword(ClientFixture.Email, ClientFixture.Password) !== undefined);
        assert.notEqual(await clients.Authenticate(ClientFixture.TenantId, ClientFixture.ClientId, ClientFixture.Secret), undefined);
        assert.equal((await clients.Find(ClientFixture.TenantId, ClientFixture.ClientId))?.RedirectAllowed(ClientFixture.Redirect), true);
    });
});

test('ResetPassword replaces an account password over https: the new one authenticates, the old one no longer does', async () =>
{
    await ClientFixture.WithHost(async (host, realms, _clients, ca) =>
    {
        const client = new IdpAdminClient({ baseUrl: ClientFixture.UrlOf(host), adminToken: ClientFixture.Token, ca });
        await client.EnsureRealm(ClientFixture.TenantId, ClientFixture.DisplayName);
        await client.SeedAccount(ClientFixture.TenantId, { email: ClientFixture.Email, principalId: ClientFixture.PrincipalId, displayName: ClientFixture.Ann, password: ClientFixture.Password });
        const fresh = ClientFixture.Password + '-reset';
        await client.ResetPassword(ClientFixture.TenantId, ClientFixture.PrincipalId, fresh);
        const realm = realms.For(ClientFixture.TenantId);
        assert.ok(realm !== undefined);
        assert.ok(await realm.AuthenticatePassword(ClientFixture.Email, fresh) !== undefined);
        assert.equal(await realm.AuthenticatePassword(ClientFixture.Email, ClientFixture.Password), undefined);
    });
});

test('ResetPassword for an unknown principal throws IdpAdminError 404 unknown_account without the password', async () =>
{
    await ClientFixture.WithHost(async (host, _realms, _clients, ca) =>
    {
        const client = new IdpAdminClient({ baseUrl: ClientFixture.UrlOf(host), adminToken: ClientFixture.Token, ca });
        await client.EnsureRealm(ClientFixture.TenantId, ClientFixture.DisplayName);
        await assert.rejects(client.ResetPassword(ClientFixture.TenantId, 'nobody', ClientFixture.Password), (err: unknown) =>
        {
            assert.ok(err instanceof IdpAdminError);
            assert.equal(err.Status, 404);
            assert.equal(err.Code, 'unknown_account');
            assert.ok(!String(err).includes(ClientFixture.Password));
            return true;
        });
    });
});

test('a wrong admin token throws IdpAdminError with status 401 and no secret in the message', async () =>
{
    await ClientFixture.WithHost(async (host, realms, _clients, ca) =>
    {
        const client = new IdpAdminClient({ baseUrl: ClientFixture.UrlOf(host), adminToken: ClientFixture.BadToken, ca });
        const calls = [
            () => client.EnsureRealm(ClientFixture.TenantId, ClientFixture.DisplayName),
            () => client.SeedAccount(ClientFixture.TenantId, { email: ClientFixture.Email, principalId: ClientFixture.PrincipalId, displayName: ClientFixture.Ann, password: ClientFixture.Password }),
            () => client.RegisterClient(ClientFixture.TenantId, { clientId: ClientFixture.ClientId, redirectUris: [ClientFixture.Redirect], secret: ClientFixture.Secret })
        ];
        for (const call of calls)
        {
            await assert.rejects(call, (err: unknown) =>
            {
                assert.ok(err instanceof IdpAdminError);
                assert.equal(err.Status, ClientFixture.Unauthorized);
                const text = String(err) + err.message;
                assert.ok(!text.includes(ClientFixture.Password));
                assert.ok(!text.includes(ClientFixture.Secret));
                assert.ok(!text.includes(ClientFixture.BadToken));
                return true;
            });
        }
        assert.equal(realms.For(ClientFixture.TenantId), undefined);
    });
});

interface CapturedRequest
{
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

class CaptureFixture
{
    public static readonly DirPrefix = 'idp-admin-capture-';
    public static readonly CaDirName = 'ca';
    public static readonly Localhost = 'localhost';
    public static readonly Loopback = '127.0.0.1';
    public static readonly Utf8 = 'utf8';
    public static readonly Token = 'capture-admin-token';
    public static readonly TenantId = 'tenant/odd 1';
    public static readonly ClientId = 'app/one 1';
    public static readonly EncodedPath = '/_admin/realms/tenant%2Fodd%201/clients/app%2Fone%201';
    public static readonly ClientsPath = '/_admin/realms/tenant%2Fodd%201/clients';
    public static readonly Redirect = 'https://app.example.test/cb';
    public static readonly Secret = 'capture-client-secret';
    public static readonly Authorization = 'authorization';
    public static readonly BearerPrefix = 'Bearer ';
    public static readonly ContentLength = 'content-length';
    public static readonly ContentType = 'content-type';
    public static readonly JsonType = 'application/json';
    public static readonly HttpsScheme = 'https://';
    public static readonly Colon = ':';
    public static readonly Delete = 'DELETE';
    public static readonly Post = 'POST';
    public static readonly OkBody = '{"clientId":"app/one 1"}';
    public static readonly NotFoundBody = '{"error":"not_found"}';
    public static readonly NotFound = 404;
    public static readonly Ok = 200;
    public static readonly ClosedPort = 1;

    public static async WithServer(status: number, responseBody: string, body: (url: string, ca: string, seen: CapturedRequest[]) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), CaptureFixture.DirPrefix));
        const seen: CapturedRequest[] = [];
        let server: https.Server | undefined;
        try
        {
            const ca = DevCa.EnsureAt(path.join(dir, CaptureFixture.CaDirName), CaptureFixture.Localhost);
            const tls = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile });
            server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) =>
            {
                const chunks: Buffer[] = [];
                req.on('data', (c: Buffer) => chunks.push(c));
                req.on('end', () =>
                {
                    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
                    res.writeHead(status, { [CaptureFixture.ContentType]: CaptureFixture.JsonType });
                    res.end(responseBody);
                });
            });
            await new Promise<void>(resolve => server!.listen(0, CaptureFixture.Loopback, resolve));
            const port = (server.address() as AddressInfo).port;
            await body(CaptureFixture.HttpsScheme + CaptureFixture.Localhost + CaptureFixture.Colon + port, fs.readFileSync(ca.caFile, CaptureFixture.Utf8), seen);
        }
        finally
        {
            if (server !== undefined)
            {
                await new Promise<void>(resolve => server!.close(() => resolve()));
            }
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
}

test('DeregisterClient resolves on 200 and sends a bodyless DELETE with no Content-Length', async () =>
{
    await CaptureFixture.WithServer(CaptureFixture.Ok, CaptureFixture.OkBody, async (url, ca, seen) =>
    {
        const client = new IdpAdminClient({ baseUrl: url, adminToken: CaptureFixture.Token, ca });
        await client.DeregisterClient(CaptureFixture.TenantId, CaptureFixture.ClientId);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].method, CaptureFixture.Delete);
        assert.equal(seen[0].url, CaptureFixture.EncodedPath);
        assert.equal(seen[0].headers[CaptureFixture.Authorization], CaptureFixture.BearerPrefix + CaptureFixture.Token);
        assert.equal(seen[0].headers[CaptureFixture.ContentLength], undefined);
        assert.equal(seen[0].headers[CaptureFixture.ContentType], undefined);
        assert.equal(seen[0].body.length, 0);
    });
});

test('DeregisterClient rejects a 404 with IdpAdminError carrying status 404', async () =>
{
    await CaptureFixture.WithServer(CaptureFixture.NotFound, CaptureFixture.NotFoundBody, async (url, ca) =>
    {
        const client = new IdpAdminClient({ baseUrl: url, adminToken: CaptureFixture.Token, ca });
        await assert.rejects(() => client.DeregisterClient(CaptureFixture.TenantId, CaptureFixture.ClientId), (err: unknown) =>
        {
            assert.ok(err instanceof IdpAdminError);
            assert.equal(err.Status, CaptureFixture.NotFound);
            assert.ok(!(String(err) + err.message).includes(CaptureFixture.Token));
            return true;
        });
    });
});

test('DeregisterClient rejects a transport failure with IdpAdminTransportError', async () =>
{
    await CaptureFixture.WithServer(CaptureFixture.Ok, CaptureFixture.OkBody, async (_url, ca) =>
    {
        const dead = CaptureFixture.HttpsScheme + CaptureFixture.Loopback + CaptureFixture.Colon + CaptureFixture.ClosedPort;
        const client = new IdpAdminClient({ baseUrl: dead, adminToken: CaptureFixture.Token, ca });
        await assert.rejects(() => client.DeregisterClient(CaptureFixture.TenantId, CaptureFixture.ClientId), (err: unknown) =>
        {
            assert.ok(err instanceof IdpAdminTransportError);
            assert.ok(!(String(err) + err.message).includes(CaptureFixture.Token));
            return true;
        });
    });
});

test('RegisterClient still sends its JSON body with Content-Length and Content-Type', async () =>
{
    await CaptureFixture.WithServer(CaptureFixture.Ok, CaptureFixture.OkBody, async (url, ca, seen) =>
    {
        const client = new IdpAdminClient({ baseUrl: url, adminToken: CaptureFixture.Token, ca });
        await client.RegisterClient(CaptureFixture.TenantId, { clientId: CaptureFixture.ClientId, redirectUris: [CaptureFixture.Redirect], secret: CaptureFixture.Secret });
        assert.equal(seen.length, 1);
        assert.equal(seen[0].method, CaptureFixture.Post);
        assert.equal(seen[0].url, CaptureFixture.ClientsPath);
        const expected = Buffer.from(JSON.stringify({ clientId: CaptureFixture.ClientId, redirectUris: [CaptureFixture.Redirect], secret: CaptureFixture.Secret }), CaptureFixture.Utf8);
        assert.deepEqual(seen[0].body, expected);
        assert.equal(seen[0].headers[CaptureFixture.ContentLength], String(expected.length));
        assert.equal(seen[0].headers[CaptureFixture.ContentType], CaptureFixture.JsonType);
    });
});
