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
import { IdpAdminClient } from '../idp-admin-client.js';
import type { IdpConnection, IIdpService } from '../idp-service.js';
import { ClientRegistry } from '../client-registry.js';
import { TenantRegistry } from '../tenant-registry.js';
import { HiveRegistry } from '../hive-registry.js';
import { PlatformDirectory, RecordExistsError, UnknownClientError } from '../platform-directory.js';
import { TenantProvisioningService } from '../tenant-provisioning-service.js';

class FakeIdp implements IIdpService
{
    public constructor(private readonly conn: IdpConnection | Error)
    {
    }

    public async EnsureForTenant(_tenantId: string, _displayName: string): Promise<IdpConnection>
    {
        if (this.conn instanceof Error)
        {
            throw this.conn;
        }
        return this.conn;
    }
}

class SpyAdminClient extends IdpAdminClient
{
    public constructor(conn: IdpConnection, private readonly seen: string[])
    {
        super(conn);
    }

    // Skips the realm call so a bad token fails at SeedAccount, the step that carries the password.
    public override async EnsureRealm(_tenantId: string, _displayName: string): Promise<void>
    {
    }

    public override async SeedAccount(tenantId: string, account: Parameters<IdpAdminClient['SeedAccount']>[1]): Promise<void>
    {
        this.seen.push(account.password);
        return super.SeedAccount(tenantId, account);
    }
}

class ProvFixture
{
    public static readonly DirPrefix = 'tenant-prov-';
    public static readonly KeyFile = 'idp-signing.pem';
    public static readonly CaDir = 'ca';
    public static readonly RealmsDir = 'realms';
    public static readonly ClientsFile = 'clients.json';
    public static readonly TenantsFile = 'tenants.json';
    public static readonly HivesFile = 'hives.json';
    public static readonly Localhost = 'localhost';
    public static readonly Loopback = '127.0.0.1';
    public static readonly BaseUrl = 'https://localhost';
    public static readonly Utf8 = 'utf8';
    public static readonly Token = 'admin-token-for-prov-tests';
    public static readonly TokenRef = 'admin-token';
    public static readonly CaRef = '/data/idp/tenant-1/tls';
    public static readonly BadClientId = 'no-such-client';
    public static readonly BadToken = 'wrong-prov-token';
    public static readonly TenantId = 'tenant-1';
    public static readonly ClientId = 'client-1';
    public static readonly ClientName = 'Client One';
    public static readonly DisplayName = 'Tenant One';
    public static readonly OwnerEmail = 'owner@example.test';
    public static readonly OwnerPrincipal = 'owner';
    public static readonly HttpsScheme = 'https://';
    public static readonly Colon = ':';
    public static readonly PemMarker = 'BEGIN CERTIFICATE';
    public static readonly LaunchFailed = 'launch failed';
    public static readonly UnknownId = 'nope';
    public static readonly WrongSuffix = 'x';
    public static readonly MinPasswordLength = 24;

    public static async WithHost(body: (conn: IdpConnection, realms: IdpRealmSet, directory: PlatformDirectory) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), ProvFixture.DirPrefix));
        let host: IdpHost | undefined;
        try
        {
            const key = await IdpSigningKey.LoadOrCreate(path.join(dir, ProvFixture.KeyFile));
            const ca = DevCa.EnsureAt(path.join(dir, ProvFixture.CaDir), ProvFixture.Localhost);
            const tls = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile });
            const realmsDir = path.join(dir, ProvFixture.RealmsDir);
            const realms = new IdpRealmSet([], (tenantId, displayName) => IdpRealm.OpenFor(realmsDir, tenantId, displayName, randomBytes(32)));
            const clients = new IdpClientStore();
            const admin = new IdpAdminEndpoint(ProvFixture.Token, realms, clients);
            host = new IdpHost(ProvFixture.BaseUrl, key, realms, clients, new InMemoryAuthorizationCodeStore(), new IdpSsoSessionStore(), tls, true, admin);
            await host.Listen(0, ProvFixture.Loopback);
            const conn: IdpConnection = {
                baseUrl: ProvFixture.HttpsScheme + ProvFixture.Localhost + ProvFixture.Colon + host.Address().port,
                browserBaseUrl: ProvFixture.HttpsScheme + ProvFixture.Localhost + ProvFixture.Colon + host.Address().port,
                ca: fs.readFileSync(ca.caFile),
                adminToken: ProvFixture.Token,
                adminTokenRef: ProvFixture.TokenRef,
                caDir: ProvFixture.CaRef
            };
            const directory = new PlatformDirectory(
                new ClientRegistry(path.join(dir, ProvFixture.ClientsFile)),
                new TenantRegistry(path.join(dir, ProvFixture.TenantsFile)),
                new HiveRegistry(path.join(dir, ProvFixture.HivesFile)),
                { List: () => [] });
            await directory.Load();
            await directory.CreateClient({ id: ProvFixture.ClientId, displayName: ProvFixture.ClientName });
            await body(conn, realms, directory);
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

    public static Input(): { id: string; clientId: string; displayName: string; ownerEmail: string }
    {
        return { id: ProvFixture.TenantId, clientId: ProvFixture.ClientId, displayName: ProvFixture.DisplayName, ownerEmail: ProvFixture.OwnerEmail };
    }

    public static Service(conn: IdpConnection, directory: PlatformDirectory): TenantProvisioningService
    {
        return new TenantProvisioningService(new FakeIdp(conn), directory, c => new IdpAdminClient(c));
    }
}

test('Provision ensures the realm, seeds an Owner who can authenticate, and persists non-secret metadata', async () =>
{
    await ProvFixture.WithHost(async (conn, realms, directory) =>
    {
        const { record, ownerPassword } = await ProvFixture.Service(conn, directory).Provision(ProvFixture.Input());
        assert.ok(ownerPassword.length >= ProvFixture.MinPasswordLength);
        const realm = realms.For(ProvFixture.TenantId);
        assert.ok(realm !== undefined);
        assert.ok(await realm.Authenticate(ProvFixture.OwnerEmail, ownerPassword) !== null);
        assert.equal(await realm.Authenticate(ProvFixture.OwnerEmail, ownerPassword + ProvFixture.WrongSuffix), null);
        assert.equal(record.ownerEmail, ProvFixture.OwnerEmail);
        assert.equal(record.ownerPrincipalId, ProvFixture.OwnerPrincipal);
        assert.equal(record.idpBaseUrl, conn.baseUrl);
        assert.equal(record.idpAdminTokenRef, ProvFixture.TokenRef);
        assert.equal(record.idpCaRef, ProvFixture.CaRef);
        assert.deepEqual(directory.GetTenant(ProvFixture.TenantId), record);
    });
});

test('the persisted record never contains the password, the admin token, or the CA', async () =>
{
    await ProvFixture.WithHost(async (conn, _realms, directory) =>
    {
        const { record, ownerPassword } = await ProvFixture.Service(conn, directory).Provision(ProvFixture.Input());
        const text = JSON.stringify(record) + JSON.stringify(directory.GetTenant(ProvFixture.TenantId));
        assert.ok(!text.includes(ownerPassword));
        assert.ok(!text.includes(ProvFixture.Token));
        assert.ok(!text.includes(ProvFixture.PemMarker));
    });
});

test('failures do not leak secrets and leave no tenant record behind', async () =>
{
    await ProvFixture.WithHost(async (conn, _realms, directory) =>
    {
        const bad: IdpConnection = { ...conn, adminToken: ProvFixture.BadToken };
        const seen: string[] = [];
        const spying = new TenantProvisioningService(new FakeIdp(bad), directory, c => new SpyAdminClient(c, seen));
        await assert.rejects(spying.Provision(ProvFixture.Input()), (err: unknown) =>
        {
            const text = String(err) + (err as Error).message + ((err as Error).stack ?? '');
            assert.ok(!text.includes(ProvFixture.BadToken));
            assert.ok(!text.includes(ProvFixture.Token));
            assert.ok(seen.length > 0);
            for (const pw of seen)
            {
                assert.ok(!text.includes(pw));
            }
            return true;
        });
        assert.equal(directory.GetTenant(ProvFixture.TenantId), undefined);

        const failing = new TenantProvisioningService(new FakeIdp(new Error(ProvFixture.LaunchFailed)), directory, c => new IdpAdminClient(c));
        await assert.rejects(failing.Provision(ProvFixture.Input()), new RegExp(ProvFixture.LaunchFailed));
        assert.equal(directory.GetTenant(ProvFixture.TenantId), undefined);
    });
});

test('Provision fails fast, before any IdP mutation, for an unknown client or a duplicate tenant', async () =>
{
    await ProvFixture.WithHost(async (conn, realms, directory) =>
    {
        const service = ProvFixture.Service(conn, directory);
        await assert.rejects(service.Provision({ ...ProvFixture.Input(), clientId: ProvFixture.BadClientId }), UnknownClientError);
        assert.equal(realms.For(ProvFixture.TenantId), undefined);
        await directory.CreateTenant({ id: ProvFixture.TenantId, clientId: ProvFixture.ClientId, displayName: ProvFixture.DisplayName });
        await assert.rejects(service.Provision(ProvFixture.Input()), RecordExistsError);
        assert.equal(realms.For(ProvFixture.TenantId), undefined);
    });
});

test('re-provisioning is rejected cleanly by the directory and the original password keeps working', async () =>
{
    await ProvFixture.WithHost(async (conn, realms, directory) =>
    {
        const service = ProvFixture.Service(conn, directory);
        const first = await service.Provision(ProvFixture.Input());
        await assert.rejects(service.Provision(ProvFixture.Input()), (err: unknown) =>
        {
            assert.ok(err instanceof RecordExistsError);
            assert.ok(!String(err).includes(first.ownerPassword));
            return true;
        });
        const realm = realms.For(ProvFixture.TenantId);
        assert.ok(realm !== undefined);
        assert.ok(await realm.Authenticate(ProvFixture.OwnerEmail, first.ownerPassword) !== null);
    });
});
