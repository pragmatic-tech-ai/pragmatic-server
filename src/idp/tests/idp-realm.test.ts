import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity';
import { FileIdentityStores } from '@pragmatic-tech-ai/todl-identity-node';
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node';
import { IdpRealm } from '../idp-realm.js';

class RealmTestFixture
{
    public static readonly DirPrefix = 'idp-realm-';
    public static readonly TenantId = 'tenant-1';
    public static readonly DisplayName = 'Tenant One';
    public static readonly Email = 'a@t';
    public static readonly PrincipalId = 'p-1';
    public static readonly Password = 'pw-correct-horse';
    public static readonly WrongPassword = 'nope';
    public static readonly GhostEmail = 'ghost@t';
    public static readonly Argon2Prefix = '$argon2';

    public static async WithRealm(body: (realm: IdpRealm, dir: string, key: Buffer) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), RealmTestFixture.DirPrefix));
        try
        {
            const key = randomBytes(32);
            const realm = await IdpRealm.OpenFor(dir, RealmTestFixture.TenantId, RealmTestFixture.DisplayName, key);
            await realm.SeedAccount(RealmTestFixture.Email, RealmTestFixture.PrincipalId, RealmTestFixture.Password);
            await body(realm, dir, key);
        }
        finally
        {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
}

test('a seeded account authenticates with its password', async () =>
{
    await RealmTestFixture.WithRealm(async realm =>
    {
        const result = await realm.Authenticate(RealmTestFixture.Email, RealmTestFixture.Password);
        assert.ok(result instanceof AuthenticatedResult);
        assert.equal(result.Principal.Id, RealmTestFixture.PrincipalId);
        assert.equal(result.Principal.TenantId, RealmTestFixture.TenantId);
        assert.equal(realm.TenantId(), RealmTestFixture.TenantId);
    });
});

test('a wrong password is rejected', async () =>
{
    await RealmTestFixture.WithRealm(async realm =>
    {
        assert.equal(await realm.Authenticate(RealmTestFixture.Email, RealmTestFixture.WrongPassword), null);
    });
});

test('an unknown email is rejected the same way (no enumeration)', async () =>
{
    await RealmTestFixture.WithRealm(async realm =>
    {
        const unknown = await realm.Authenticate(RealmTestFixture.GhostEmail, RealmTestFixture.Password);
        const wrong = await realm.Authenticate(RealmTestFixture.Email, RealmTestFixture.WrongPassword);
        assert.equal(unknown, null);
        assert.equal(unknown, wrong);
    });
});

test('the stored secret is a hash, never the password', async () =>
{
    await RealmTestFixture.WithRealm(async (_realm, dir, key) =>
    {
        const stores = await FileIdentityStores.Open(new NodeFsStorage(path.join(dir, RealmTestFixture.TenantId)), key);
        const stored = await stores.Secrets.Get(IdpRealm.SecretRefFor(RealmTestFixture.PrincipalId));
        assert.ok(stored);
        assert.ok(!String(stored).includes(RealmTestFixture.Password));
        assert.ok(String(stored).startsWith(RealmTestFixture.Argon2Prefix));
    });
});
