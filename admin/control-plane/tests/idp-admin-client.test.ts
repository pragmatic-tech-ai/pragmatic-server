import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DevCa, IdpTlsMaterial } from '../../../src/idp/dev-ca.js';
import { IdpAdminEndpoint } from '../../../src/idp/idp-admin-endpoint.js';
import { IdpClientStore } from '../../../src/idp/idp-client-store.js';
import { IdpHost, IdpRealmSet } from '../../../src/idp/idp-host.js';
import { IdpRealm } from '../../../src/idp/idp-realm.js';
import { IdpSigningKey } from '../../../src/idp/idp-signing-key.js';
import { IdpSsoSessionStore } from '../../../src/idp/idp-sso-session.js';
import { InMemoryAuthorizationCodeStore } from '../../../src/idp/authorization-code-store.js';
import { IdpAdminClient, IdpAdminError } from '../idp-admin-client.js';

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
    public static readonly Token = 'admin-token-for-tests';
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

    public static async WithHost(body: (host: IdpHost, realms: IdpRealmSet, clients: IdpClientStore, caPem: string) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), ClientFixture.DirPrefix));
        let host: IdpHost | undefined;
        try
        {
            const key = await IdpSigningKey.LoadOrCreate(path.join(dir, ClientFixture.KeyFileName));
            const ca = DevCa.EnsureAt(path.join(dir, ClientFixture.CaDirName), ClientFixture.Localhost);
            const tls = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile });
            const realmsDir = path.join(dir, ClientFixture.RealmDirName);
            const realms = new IdpRealmSet([], (tenantId, displayName) => IdpRealm.OpenFor(realmsDir, tenantId, displayName, randomBytes(32)));
            const clients = new IdpClientStore();
            const admin = new IdpAdminEndpoint(ClientFixture.Token, realms, clients);
            host = new IdpHost(ClientFixture.BaseUrl, key, realms, clients, new InMemoryAuthorizationCodeStore(), new IdpSsoSessionStore(), tls, true, admin);
            await host.Listen(0, ClientFixture.Loopback);
            await body(host, realms, clients, fs.readFileSync(ca.caFile, ClientFixture.Utf8));
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

    public static UrlOf(host: IdpHost): string
    {
        return ClientFixture.HttpsScheme + ClientFixture.Localhost + ClientFixture.Colon + host.Address().port;
    }
}

test('EnsureRealm, SeedAccount, RegisterClient round-trip over https', async () =>
{
    await ClientFixture.WithHost(async (host, realms, clients, ca) =>
    {
        const client = new IdpAdminClient({ baseUrl: ClientFixture.UrlOf(host), adminToken: ClientFixture.Token, ca });
        await client.EnsureRealm(ClientFixture.TenantId, ClientFixture.DisplayName);
        await client.SeedAccount(ClientFixture.TenantId, { email: ClientFixture.Email, principalId: ClientFixture.PrincipalId, displayName: 'Ann', password: ClientFixture.Password });
        await client.RegisterClient(ClientFixture.TenantId, { clientId: ClientFixture.ClientId, redirectUris: [ClientFixture.Redirect], secret: ClientFixture.Secret });

        const realm = realms.For(ClientFixture.TenantId);
        assert.ok(realm !== undefined);
        assert.ok(await realm.Authenticate(ClientFixture.Email, ClientFixture.Password) !== null);
        assert.equal(await clients.VerifySecret(ClientFixture.TenantId, ClientFixture.ClientId, ClientFixture.Secret), true);
        assert.equal(clients.RedirectAllowed(ClientFixture.TenantId, ClientFixture.ClientId, ClientFixture.Redirect), true);
    });
});

test('a wrong admin token throws IdpAdminError with status 401 and no secret in the message', async () =>
{
    await ClientFixture.WithHost(async (host, _realms, _clients, ca) =>
    {
        const client = new IdpAdminClient({ baseUrl: ClientFixture.UrlOf(host), adminToken: ClientFixture.BadToken, ca });
        const calls = [
            () => client.EnsureRealm(ClientFixture.TenantId, ClientFixture.DisplayName),
            () => client.SeedAccount(ClientFixture.TenantId, { email: ClientFixture.Email, principalId: ClientFixture.PrincipalId, displayName: 'Ann', password: ClientFixture.Password }),
            () => client.RegisterClient(ClientFixture.TenantId, { clientId: ClientFixture.ClientId, redirectUris: [ClientFixture.Redirect], secret: ClientFixture.Secret })
        ];
        for (const call of calls)
        {
            await assert.rejects(call, (err: unknown) =>
            {
                assert.ok(err instanceof IdpAdminError);
                assert.equal(err.Status, 401);
                const text = String(err) + err.message;
                assert.ok(!text.includes(ClientFixture.Password));
                assert.ok(!text.includes(ClientFixture.Secret));
                assert.ok(!text.includes(ClientFixture.BadToken));
                return true;
            });
        }
    });
});
