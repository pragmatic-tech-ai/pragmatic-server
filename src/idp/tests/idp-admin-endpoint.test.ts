import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { IdpRealmSet } from '../idp-host.js';
import { IdpRealm } from '../idp-realm.js';
import { IdpClientStore } from '../idp-client-store.js';
import { IdpAdminEndpoint } from '../idp-admin-endpoint.js';
import type { AdminResult } from '../idp-admin-endpoint.js';

class AdminFixture
{
    public static readonly Token = 'admin-token-correct-horse-battery';
    public static readonly Bearer = 'Bearer ';
    public static readonly Basic = 'Basic ';
    public static readonly TempPrefix = 'idp-admin-';
    public static readonly Tenant = 'tenant-1';
    public static readonly Reserved = '_x';
    public static readonly Realms = 'realms';
    public static readonly Accounts = 'accounts';
    public static readonly Clients = 'clients';
    public static readonly Put = 'PUT';
    public static readonly Post = 'POST';
    public static readonly Get = 'GET';
    public static readonly Delete = 'DELETE';
    public static readonly Other = 'other';
    public static readonly Display = 'Tenant One';
    public static readonly Email = 'a@example.com';
    public static readonly PrincipalId = 'p-1';
    public static readonly Password = 'S3cret-passw0rd-xyz';
    public static readonly ClientId = 'client-1';
    public static readonly ClientSecret = 'client-secret-unique-9981';
    public static readonly Redirect = 'https://app.example.com/cb';
    public static readonly SameLengthWrong = 'wrong-token-of-same-len-xxxxxxxx';
    public static readonly Extra = 'extra';
    public static readonly MasterKeyBytes = 32;
    public static readonly OkStatus = 200;
    public static readonly BadRequest = 400;
    public static readonly Unauthorized = 401;
    public static readonly NotFound = 404;

    public readonly realms: IdpRealmSet;
    public readonly clients = new IdpClientStore();
    public readonly endpoint: IdpAdminEndpoint;

    public constructor(root: string)
    {
        const masterKey = randomBytes(AdminFixture.MasterKeyBytes);
        this.realms = new IdpRealmSet([], (t, d) => IdpRealm.OpenFor(root, t, d, masterKey));
        this.endpoint = new IdpAdminEndpoint([AdminFixture.Token], this.realms, this.clients);
    }

    public static async Create(): Promise<AdminFixture>
    {
        return new AdminFixture(await mkdtemp(join(tmpdir(), AdminFixture.TempPrefix)));
    }

    public static Auth(token: string = AdminFixture.Token): string
    {
        return AdminFixture.Bearer + token;
    }

    public PutRealm(tenant: string = AdminFixture.Tenant, auth: string | null = AdminFixture.Auth()): Promise<AdminResult>
    {
        return this.endpoint.Handle(AdminFixture.Put, [AdminFixture.Realms, tenant], auth ?? undefined, { displayName: AdminFixture.Display });
    }

    public AccountBody(): Record<string, unknown>
    {
        return { email: AdminFixture.Email, principalId: AdminFixture.PrincipalId, displayName: 'A', password: AdminFixture.Password };
    }

    public ClientBody(): Record<string, unknown>
    {
        return { clientId: AdminFixture.ClientId, redirectUris: [AdminFixture.Redirect], secret: AdminFixture.ClientSecret };
    }

    public PostAccount(body: unknown, tenant: string = AdminFixture.Tenant): Promise<AdminResult>
    {
        return this.endpoint.Handle(AdminFixture.Post, [AdminFixture.Realms, tenant, AdminFixture.Accounts], AdminFixture.Auth(), body);
    }

    public PostClient(body: unknown, tenant: string = AdminFixture.Tenant): Promise<AdminResult>
    {
        return this.endpoint.Handle(AdminFixture.Post, [AdminFixture.Realms, tenant, AdminFixture.Clients], AdminFixture.Auth(), body);
    }
}

test('a valid bearer token is accepted', async () =>
{
    const f = await AdminFixture.Create();
    assert.equal((await f.PutRealm()).Status, AdminFixture.OkStatus);
});

test('a missing Authorization header is 401', async () =>
{
    const f = await AdminFixture.Create();
    const r = await f.PutRealm(AdminFixture.Tenant, null);
    assert.equal(r.Status, AdminFixture.Unauthorized);
    assert.deepEqual(r.Body, { error: 'unauthorized' });
});

test('a wrong token is 401', async () =>
{
    const f = await AdminFixture.Create();
    assert.equal((await f.PutRealm(AdminFixture.Tenant, AdminFixture.Auth(AdminFixture.SameLengthWrong))).Status, AdminFixture.Unauthorized);
});

test('a token of a different length is 401, not a thrown error', async () =>
{
    const f = await AdminFixture.Create();
    assert.equal((await f.PutRealm(AdminFixture.Tenant, AdminFixture.Auth('x'))).Status, AdminFixture.Unauthorized);
    assert.equal((await f.PutRealm(AdminFixture.Tenant, AdminFixture.Auth(AdminFixture.Token + AdminFixture.Extra))).Status, AdminFixture.Unauthorized);
    assert.equal((await f.PutRealm(AdminFixture.Tenant, AdminFixture.Auth(''))).Status, AdminFixture.Unauthorized);
});

test('a non-Bearer scheme is 401', async () =>
{
    const f = await AdminFixture.Create();
    assert.equal((await f.PutRealm(AdminFixture.Tenant, AdminFixture.Basic + AdminFixture.Token)).Status, AdminFixture.Unauthorized);
    assert.equal((await f.PutRealm(AdminFixture.Tenant, AdminFixture.Token)).Status, AdminFixture.Unauthorized);
});

test('auth is checked before routing and body parsing', async () =>
{
    const f = await AdminFixture.Create();
    const r = await f.endpoint.Handle(AdminFixture.Delete, [AdminFixture.Other], undefined, 42);
    assert.equal(r.Status, AdminFixture.Unauthorized);
});

test('PUT realm is 200 and idempotent', async () =>
{
    const f = await AdminFixture.Create();
    const a = await f.PutRealm();
    const b = await f.PutRealm();
    assert.equal(a.Status, AdminFixture.OkStatus);
    assert.equal(b.Status, AdminFixture.OkStatus);
    assert.deepEqual(b.Body, { tenantId: AdminFixture.Tenant });
});

test('POST account is 200 and seeds a realm-authenticatable login', async () =>
{
    const f = await AdminFixture.Create();
    await f.PutRealm();
    const r = await f.PostAccount(f.AccountBody());
    assert.equal(r.Status, AdminFixture.OkStatus);
    assert.deepEqual(r.Body, { principalId: AdminFixture.PrincipalId });
    const auth = await f.realms.For(AdminFixture.Tenant)!.Authenticate(AdminFixture.Email, AdminFixture.Password);
    assert.ok(auth);
});

test('POST client is 200 and the secret is verifiable but never echoed', async () =>
{
    const f = await AdminFixture.Create();
    await f.PutRealm();
    const r = await f.PostClient(f.ClientBody());
    assert.equal(r.Status, AdminFixture.OkStatus);
    assert.deepEqual(r.Body, { clientId: AdminFixture.ClientId });
    assert.equal(await f.clients.VerifySecret(AdminFixture.Tenant, AdminFixture.ClientId, AdminFixture.ClientSecret), true);
    assert.ok(!JSON.stringify(r.Body).includes(AdminFixture.ClientSecret));
});

test('a malformed body is 400', async () =>
{
    const f = await AdminFixture.Create();
    await f.PutRealm();
    for (const bad of [null, undefined, 'str', 7, [], {}])
    {
        assert.equal((await f.PostAccount(bad)).Status, AdminFixture.BadRequest);
        assert.equal((await f.PostClient(bad)).Status, AdminFixture.BadRequest);
        assert.equal((await f.endpoint.Handle(AdminFixture.Put, [AdminFixture.Realms, AdminFixture.Tenant], AdminFixture.Auth(), bad)).Status, AdminFixture.BadRequest);
    }
    assert.equal((await f.PostAccount({ ...f.AccountBody(), password: 5 })).Status, AdminFixture.BadRequest);
    assert.equal((await f.PostAccount({ ...f.AccountBody(), email: '' })).Status, AdminFixture.BadRequest);
    assert.equal((await f.PostClient({ ...f.ClientBody(), secret: '' })).Status, AdminFixture.BadRequest);
});

test('an underscore-prefixed realm is 400 on PUT and never created by POST', async () =>
{
    const f = await AdminFixture.Create();
    assert.equal((await f.PutRealm(AdminFixture.Reserved)).Status, AdminFixture.BadRequest);
    assert.equal((await f.PostAccount(f.AccountBody(), AdminFixture.Reserved)).Status, AdminFixture.NotFound);
    assert.equal((await f.PostClient(f.ClientBody(), AdminFixture.Reserved)).Status, AdminFixture.NotFound);
});

test('POST accounts to a realm that was never ensured returns 404 unknown_realm', async () =>
{
    const f = await AdminFixture.Create();
    const a = await f.PostAccount(f.AccountBody());
    const c = await f.PostClient(f.ClientBody());
    assert.equal(a.Status, AdminFixture.NotFound);
    assert.deepEqual(a.Body, { error: 'unknown_realm' });
    assert.equal(c.Status, AdminFixture.NotFound);
    assert.deepEqual(c.Body, { error: 'unknown_realm' });
    assert.equal(f.realms.For(AdminFixture.Tenant), undefined);
});

test('empty or non-array redirectUris is 400', async () =>
{
    const f = await AdminFixture.Create();
    await f.PutRealm();
    assert.equal((await f.PostClient({ ...f.ClientBody(), redirectUris: [] })).Status, AdminFixture.BadRequest);
    assert.equal((await f.PostClient({ ...f.ClientBody(), redirectUris: 'https://x/cb' })).Status, AdminFixture.BadRequest);
    assert.equal((await f.PostClient({ ...f.ClientBody(), redirectUris: [1] })).Status, AdminFixture.BadRequest);
});

test('register-client with a malformed redirectUri is 400', async () =>
{
    const f = await AdminFixture.Create();
    await f.PutRealm();
    assert.equal((await f.PostClient({ ...f.ClientBody(), redirectUris: ['not-a-uri'] })).Status, AdminFixture.BadRequest);
});

test('unknown path or method after auth is 404', async () =>
{
    const f = await AdminFixture.Create();
    const a = await f.endpoint.Handle(AdminFixture.Get, [AdminFixture.Realms, AdminFixture.Tenant], AdminFixture.Auth(), {});
    const b = await f.endpoint.Handle(AdminFixture.Post, [AdminFixture.Other], AdminFixture.Auth(), {});
    assert.equal(a.Status, AdminFixture.NotFound);
    assert.equal(b.Status, AdminFixture.NotFound);
});

test('no 200 or 400 body contains the password or the client secret', async () =>
{
    const f = await AdminFixture.Create();
    await f.PutRealm();
    const results = [
        await f.PutRealm(),
        await f.PostAccount(f.AccountBody()),
        await f.PostAccount({ ...f.AccountBody(), email: '' }),
        await f.PostAccount(f.AccountBody(), AdminFixture.Reserved),
        await f.PostClient(f.ClientBody()),
        await f.PostClient({ ...f.ClientBody(), redirectUris: [] }),
        await f.PostClient(f.ClientBody(), AdminFixture.Reserved),
        await f.PutRealm(AdminFixture.Tenant, null),
    ];
    for (const r of results)
    {
        const text = JSON.stringify(r.Body);
        assert.ok(!text.includes(AdminFixture.Password));
        assert.ok(!text.includes(AdminFixture.ClientSecret));
        assert.ok(!text.includes(AdminFixture.Token));
    }
});

test('any member of a multi-token set authenticates; a non-member is 401', async () =>
{
    const f = await AdminFixture.Create();
    const multi = new IdpAdminEndpoint([AdminFixture.Token, AdminFixture.SameLengthWrong], f.realms, f.clients);
    const put = (token: string): Promise<AdminResult> =>
        multi.Handle(AdminFixture.Put, [AdminFixture.Realms, AdminFixture.Tenant], AdminFixture.Auth(token), { displayName: AdminFixture.Display });
    assert.equal((await put(AdminFixture.Token)).Status, AdminFixture.OkStatus);
    assert.equal((await put(AdminFixture.SameLengthWrong)).Status, AdminFixture.OkStatus);
    assert.equal((await put('not-a-member-token')).Status, AdminFixture.Unauthorized);
});

test('an empty token set rejects every request', async () =>
{
    const f = await AdminFixture.Create();
    const none = new IdpAdminEndpoint([], f.realms, f.clients);
    for (const token of [AdminFixture.Token, '', 'x'])
    {
        const r = await none.Handle(AdminFixture.Put, [AdminFixture.Realms, AdminFixture.Tenant], AdminFixture.Auth(token), { displayName: AdminFixture.Display });
        assert.equal(r.Status, AdminFixture.Unauthorized);
    }
});

class ResetFixture
{
    public static readonly Password = 'reset-pw-Zq81';
    public static readonly PasswordSegment = 'password';
    public static readonly UnknownPrincipal = 'p-ghost';
    public static readonly NoRealm = 'nope';

    public static Reset(f: AdminFixture, principalId: string, body: unknown, auth: string | null = AdminFixture.Auth(), tenant: string = AdminFixture.Tenant): Promise<AdminResult>
    {
        return f.endpoint.Handle(AdminFixture.Post, [AdminFixture.Realms, tenant, AdminFixture.Accounts, principalId, ResetFixture.PasswordSegment], auth ?? undefined, body);
    }
}

test('admin password reset sets the new password, old stops authenticating, and the result echoes no secret', async () =>
{
    const f = await AdminFixture.Create();
    await f.PutRealm();
    await f.PostAccount(f.AccountBody());
    const r = await ResetFixture.Reset(f, AdminFixture.PrincipalId, { password: ResetFixture.Password });
    assert.equal(r.Status, AdminFixture.OkStatus);
    assert.ok(!JSON.stringify(r.Body).includes(ResetFixture.Password));
    const realm = f.realms.For(AdminFixture.Tenant)!;
    assert.notEqual(await realm.Authenticate(AdminFixture.Email, ResetFixture.Password), null);
    assert.equal(await realm.Authenticate(AdminFixture.Email, AdminFixture.Password), null);
});

test('admin password reset without a valid admin token is 401 and changes nothing', async () =>
{
    const f = await AdminFixture.Create();
    await f.PutRealm();
    await f.PostAccount(f.AccountBody());
    assert.equal((await ResetFixture.Reset(f, AdminFixture.PrincipalId, { password: ResetFixture.Password }, null)).Status, AdminFixture.Unauthorized);
    assert.equal((await ResetFixture.Reset(f, AdminFixture.PrincipalId, { password: ResetFixture.Password }, AdminFixture.Auth(AdminFixture.SameLengthWrong))).Status, AdminFixture.Unauthorized);
    const realm = f.realms.For(AdminFixture.Tenant)!;
    assert.notEqual(await realm.Authenticate(AdminFixture.Email, AdminFixture.Password), null);
});

test('admin password reset: missing password is 400, unknown principal is 404, unknown realm is 404', async () =>
{
    const f = await AdminFixture.Create();
    await f.PutRealm();
    await f.PostAccount(f.AccountBody());
    assert.equal((await ResetFixture.Reset(f, AdminFixture.PrincipalId, {})).Status, AdminFixture.BadRequest);
    assert.equal((await ResetFixture.Reset(f, ResetFixture.UnknownPrincipal, { password: ResetFixture.Password })).Status, AdminFixture.NotFound);
    const noRealm = await ResetFixture.Reset(f, AdminFixture.PrincipalId, { password: ResetFixture.Password }, AdminFixture.Auth(), ResetFixture.NoRealm);
    assert.equal(noRealm.Status, AdminFixture.NotFound);
});
