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
import { PlatformDirectory, RecordExistsError, UnknownClientError, UnknownTenantError } from '../platform-directory.js';
import { IdpUnreachableError, OwnerAccountMissingError, OwnerIdpRefusedError, OwnerNotRecordedError, OwnerResetInProgressError, TenantIdpMissingError, TenantProvisioningService, type IOwnerSessionRevoker } from '../tenant-provisioning-service.js';
import { IdpAdminTransportError } from '../idp-admin-client.js';
import { TenantAccountIndex } from '../tenant-account-index.js';
import { TenantSessionKind, TenantSessionStore } from '../tenant-auth/tenant-session.js';
import { TenantPrincipalSessions } from '../tenant-auth/tenant-principal-sessions.js';

class FakeIdp implements IIdpService
{
    // Whether the tenant has an IdP record to connect to (ConnectForTenant).
    public HasRecord = true

    public constructor(private readonly conn: IdpConnection | Error)
    {
    }

    public async ConnectForTenant(_tenantId: string): Promise<IdpConnection | undefined>
    {
        return this.HasRecord && !(this.conn instanceof Error) ? this.conn : undefined;
    }

    public async TeardownForTenant(_tenantId: string): Promise<void>
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
            const sso = new IdpSsoSessionStore();
            const admin = new IdpAdminEndpoint([ProvFixture.Token], realms, clients, sso);
            host = new IdpHost(ProvFixture.BaseUrl, key, realms, clients, new InMemoryAuthorizationCodeStore(), sso, tls, true, admin);
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

test('Provision records the Owner in the account index, and ForgetTenant removes it', async () =>
{
    await ProvFixture.WithHost(async (conn, _realms, directory) =>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), ProvFixture.DirPrefix));
        try
        {
            const index = new TenantAccountIndex(path.join(dir, 'tenant-accounts.json'));
            await index.Load();
            const service = new TenantProvisioningService(new FakeIdp(conn), directory, c => new IdpAdminClient(c), undefined, index);
            await service.Provision(ProvFixture.Input());
            assert.deepEqual(index.TenantsFor(ProvFixture.OwnerEmail.toUpperCase()), [ProvFixture.TenantId]);
            await service.ForgetTenant(ProvFixture.TenantId);
            assert.deepEqual(index.TenantsFor(ProvFixture.OwnerEmail), []);
        }
        finally
        {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test('ForgetTenant ends every session of the tenant, console and desktop, and closes its connections', async () =>
{
    await ProvFixture.WithHost(async (conn, _realms, directory) =>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), ProvFixture.DirPrefix));
        try
        {
            const sessions = new TenantSessionStore(path.join(dir, 'sessions.json'), 60000);
            const principals = new TenantPrincipalSessions(sessions);
            const closedTenants: string[] = [];
            principals.Attach({ ClosePrincipal: () => 0, MoveSession: () => undefined, CloseTenant: (t: string) => { closedTenants.push(t); return 1; } });
            const service = new TenantProvisioningService(new FakeIdp(conn), directory, c => new IdpAdminClient(c), principals);
            const consoleSession = await sessions.Issue(ProvFixture.TenantId, 'owner');
            const desktop = await sessions.Issue(ProvFixture.TenantId, 'owner', undefined, TenantSessionKind.Desktop);
            const other = await sessions.Issue('other-tenant', 'owner', undefined, TenantSessionKind.Desktop);
            await service.ForgetTenant(ProvFixture.TenantId);
            assert.equal(await sessions.Validate(consoleSession.id), null);
            assert.equal(await sessions.Validate(desktop.id), null);
            assert.notEqual(await sessions.Validate(other.id), null);
            assert.deepEqual(closedTenants, [ProvFixture.TenantId]);
        }
        finally
        {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test('ForgetTenant does not fail when ending the sessions fails', async () =>
{
    await ProvFixture.WithHost(async (conn, _realms, directory) =>
    {
        const failing: IOwnerSessionRevoker = { RevokeAllFor: async () => undefined, RevokeTenant: async () => { throw new Error('disk full'); } };
        const service = new TenantProvisioningService(new FakeIdp(conn), directory, c => new IdpAdminClient(c), failing);
        await service.ForgetTenant(ProvFixture.TenantId);
    });
});

test('ForgetTenant does not fail when the index write fails', async () =>
{
    await ProvFixture.WithHost(async (conn, _realms, directory) =>
    {
        const failing = { ForgetTenant: async () => { throw new Error('disk full'); } } as unknown as TenantAccountIndex;
        const service = new TenantProvisioningService(new FakeIdp(conn), directory, c => new IdpAdminClient(c), undefined, failing);
        await service.ForgetTenant(ProvFixture.TenantId);
    });
});

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

test('ResetOwnerPassword sets a fresh strong password for the Owner principal: it authenticates, the old one stops', async () =>
{
    await ProvFixture.WithHost(async (conn, realms, directory) =>
    {
        const service = ProvFixture.Service(conn, directory);
        const first = await service.Provision(ProvFixture.Input());
        const reset = await service.ResetOwnerPassword(ProvFixture.TenantId);
        assert.equal(reset.ownerEmail, ProvFixture.OwnerEmail);
        assert.ok(reset.ownerPassword.length >= ProvFixture.MinPasswordLength);
        assert.notEqual(reset.ownerPassword, first.ownerPassword);
        const realm = realms.For(ProvFixture.TenantId);
        assert.ok(realm !== undefined);
        assert.ok(await realm.Authenticate(ProvFixture.OwnerEmail, reset.ownerPassword) !== null);
        assert.equal(await realm.Authenticate(ProvFixture.OwnerEmail, first.ownerPassword), null);
        // Nothing about the reset is stored on the record.
        assert.ok(!JSON.stringify(directory.GetTenant(ProvFixture.TenantId)).includes(reset.ownerPassword));
    });
});

test('ResetOwnerPassword: unknown tenant, no Owner recorded, no IdP record', async () =>
{
    await ProvFixture.WithHost(async (conn, _realms, directory) =>
    {
        const idp = new FakeIdp(conn);
        const service = new TenantProvisioningService(idp, directory, c => new IdpAdminClient(c));
        await assert.rejects(service.ResetOwnerPassword(ProvFixture.UnknownId), UnknownTenantError);
        await directory.CreateTenant({ id: ProvFixture.TenantId, clientId: ProvFixture.ClientId, displayName: ProvFixture.DisplayName });
        await assert.rejects(service.ResetOwnerPassword(ProvFixture.TenantId), (e: unknown) => e instanceof OwnerNotRecordedError && /no Owner/.test(e.message));
        await directory.DeleteTenant(ProvFixture.TenantId);
        await service.Provision(ProvFixture.Input());
        idp.HasRecord = false;
        await assert.rejects(service.ResetOwnerPassword(ProvFixture.TenantId), (e: unknown) => e instanceof TenantIdpMissingError && /not managed by this control plane/.test(e.message) && /within the tenant's cluster/.test(e.message));
    });
});

test('ResetOwnerPassword: an IdP without the Owner account, a refused token, an unreachable IdP - clear errors, never the password', async () =>
{
    await ProvFixture.WithHost(async (conn, realms, directory) =>
    {
        const seen: string[] = [];
        const service = new TenantProvisioningService(new FakeIdp(conn), directory, c => new ResetSpyClient(c, seen));
        await service.Provision(ProvFixture.Input());
        // The Owner account is gone from the realm (e.g. the realm was rebuilt): unknown_account.
        const ghost = await directory.CreateProvisionedTenant({ id: 'tenant-2', clientId: ProvFixture.ClientId, displayName: 'Two', ownerEmail: 'two@example.test', ownerPrincipalId: 'owner', idpBaseUrl: conn.baseUrl });
        await new IdpAdminClient(conn).EnsureRealm(ghost.id, ghost.displayName);
        await assert.rejects(service.ResetOwnerPassword(ghost.id), (e: unknown) => e instanceof OwnerAccountMissingError && /no Owner account/.test(e.message) && !seen.some(pw => String(e).includes(pw)));
        const refusing = new TenantProvisioningService(new FakeIdp({ ...conn, adminToken: ProvFixture.BadToken }), directory, c => new ResetSpyClient(c, seen));
        await assert.rejects(refusing.ResetOwnerPassword(ProvFixture.TenantId), (e: unknown) => e instanceof OwnerIdpRefusedError && /401/.test(e.message) && !seen.some(pw => String(e).includes(pw)) && !String(e).includes(ProvFixture.BadToken));
        const unreachable = new TenantProvisioningService(new FakeIdp({ ...conn, baseUrl: 'https://localhost:1' }), directory, c => new ResetSpyClient(c, seen));
        await assert.rejects(unreachable.ResetOwnerPassword(ProvFixture.TenantId), (e: unknown) => e instanceof IdpUnreachableError && /could not be reached/.test(e.message) && !seen.some(pw => String(e).includes(pw)));
        assert.ok(seen.length >= 3);
        assert.ok(realms.For(ProvFixture.TenantId) !== undefined);
    });
});

// Records the passwords a reset sends, so a test can assert none leaks into an error.
class ResetSpyClient extends IdpAdminClient
{
    public constructor(conn: IdpConnection, private readonly seen: string[])
    {
        super(conn);
    }

    public override async ResetPassword(tenantId: string, principalId: string, password: string): Promise<void>
    {
        this.seen.push(password);
        return super.ResetPassword(tenantId, principalId, password);
    }
}

test('ResetOwnerPassword ends the Owner\'s tenant-portal sessions after the IdP reset: a session issued before no longer validates', async () =>
{
    await ProvFixture.WithHost(async (conn, _realms, directory) =>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-sessions-'));
        try
        {
            const sessions = new TenantSessionStore(path.join(dir, 'sessions.json'), 60000);
            const service = new TenantProvisioningService(new FakeIdp(conn), directory, c => new IdpAdminClient(c), new TenantPrincipalSessions(sessions));
            await service.Provision(ProvFixture.Input());
            const before = await sessions.Issue(ProvFixture.TenantId, ProvFixture.OwnerPrincipal);
            const someoneElse = await sessions.Issue(ProvFixture.TenantId, 'user-2');
            const reset = await service.ResetOwnerPassword(ProvFixture.TenantId);
            assert.equal(reset.sessionsRevoked, true);
            assert.equal(reset.warning, undefined);
            assert.equal(await sessions.Validate(before.id), null);
            assert.notEqual(await sessions.Validate(someoneElse.id), null);
        }
        finally
        {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test('a session revoke failure after the password changed still returns the password, with sessionsRevoked false and a warning', async () =>
{
    await ProvFixture.WithHost(async (conn, realms, directory) =>
    {
        const failing: IOwnerSessionRevoker = { RevokeAllFor: async () => { throw new Error('disk full'); }, RevokeTenant: async () => undefined };
        const service = new TenantProvisioningService(new FakeIdp(conn), directory, c => new IdpAdminClient(c), failing);
        await service.Provision(ProvFixture.Input());
        const reset = await service.ResetOwnerPassword(ProvFixture.TenantId);
        assert.equal(reset.sessionsRevoked, false);
        assert.match(reset.warning ?? '', /could not be ended durably: they may return after a control-plane restart/);
        assert.ok(!(reset.warning ?? '').includes(reset.ownerPassword));
        assert.ok(await realms.For(ProvFixture.TenantId)!.Authenticate(ProvFixture.OwnerEmail, reset.ownerPassword) !== null);
    });
});

test('a refused or failed IdP reset ends no session', async () =>
{
    await ProvFixture.WithHost(async (conn, _realms, directory) =>
    {
        const calls: string[] = [];
        const spy: IOwnerSessionRevoker = { RevokeAllFor: async (t: string, p: string) => { calls.push(t + '/' + p); }, RevokeTenant: async () => undefined };
        const service = new TenantProvisioningService(new FakeIdp({ ...conn, adminToken: ProvFixture.BadToken }), directory, c => new IdpAdminClient(c), spy);
        await new TenantProvisioningService(new FakeIdp(conn), directory, c => new IdpAdminClient(c)).Provision(ProvFixture.Input());
        await assert.rejects(service.ResetOwnerPassword(ProvFixture.TenantId), OwnerIdpRefusedError);
        assert.deepEqual(calls, []);
    });
});

// An admin client whose reset fails at the transport with a given code, or waits on a gate.
class TransportClient extends IdpAdminClient
{
    public Gate: Promise<void> | undefined;

    public constructor(conn: IdpConnection, private readonly code: string | undefined)
    {
        super(conn);
    }

    public override async ResetPassword(_tenantId: string, _principalId: string, _password: string): Promise<void>
    {
        if (this.Gate !== undefined)
        {
            await this.Gate;
        }
        if (this.code !== undefined)
        {
            throw new IdpAdminTransportError(this.code);
        }
    }
}

test('an unreachable IdP: refused / not found before sending -> nothing changed; timeout or reset mid-request -> may have been applied', async () =>
{
    await ProvFixture.WithHost(async (conn, _realms, directory) =>
    {
        await new TenantProvisioningService(new FakeIdp(conn), directory, c => new IdpAdminClient(c)).Provision(ProvFixture.Input());
        for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
            'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
            'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED'])
        {
            const service = new TenantProvisioningService(new FakeIdp(conn), directory, c => new TransportClient(c, code));
            await assert.rejects(service.ResetOwnerPassword(ProvFixture.TenantId), (e: unknown) => e instanceof IdpUnreachableError && /Nothing was changed/.test(e.message) && e.message.includes(code));
        }
        for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'UNKNOWN'])
        {
            const service = new TenantProvisioningService(new FakeIdp(conn), directory, c => new TransportClient(c, code));
            await assert.rejects(service.ResetOwnerPassword(ProvFixture.TenantId), (e: unknown) => e instanceof IdpUnreachableError && /may have been applied/.test(e.message) && /reset again/.test(e.message) && !/Nothing was changed/.test(e.message));
        }
    });
});

test('a second reset of the same tenant while one is in flight is refused; another tenant is not blocked', async () =>
{
    await ProvFixture.WithHost(async (conn, _realms, directory) =>
    {
        await new TenantProvisioningService(new FakeIdp(conn), directory, c => new IdpAdminClient(c)).Provision(ProvFixture.Input());
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const service = new TenantProvisioningService(new FakeIdp(conn), directory, c =>
        {
            const client = new TransportClient(c, undefined);
            client.Gate = gate;
            return client;
        });
        const first = service.ResetOwnerPassword(ProvFixture.TenantId);
        await new Promise(resolve => setImmediate(resolve));
        await assert.rejects(service.ResetOwnerPassword(ProvFixture.TenantId), (e: unknown) => e instanceof OwnerResetInProgressError && /already being reset/.test(e.message));
        release();
        assert.equal((await first).ownerEmail, ProvFixture.OwnerEmail);
        // Released: the next reset may run.
        assert.equal((await service.ResetOwnerPassword(ProvFixture.TenantId)).ownerEmail, ProvFixture.OwnerEmail);
    });
});
