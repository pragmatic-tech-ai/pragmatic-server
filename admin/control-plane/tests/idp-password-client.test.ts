import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DevCa, IdpTlsMaterial } from '../../../src/idp/dev-ca.js'
import { IdpClientStore } from '../../../src/idp/idp-client-store.js'
import { IdpHost, IdpRealmSet } from '../../../src/idp/idp-host.js'
import { IdpRealm } from '../../../src/idp/idp-realm.js'
import { IdpSigningKey } from '../../../src/idp/idp-signing-key.js'
import { IdpSsoSessionStore } from '../../../src/idp/idp-sso-session.js'
import { InMemoryAuthorizationCodeStore } from '../../../src/idp/authorization-code-store.js'
import { IdpAdminEndpoint } from '../../../src/idp/idp-admin-endpoint.js'
import type { IdpConnection } from '../idp-workload-driver.js'
import { IdpPasswordClient, IdpPasswordResult } from '../tenant-auth/idp-password-client.js'

class PasswordClientFixture
{
    public static readonly TenantId = 'tenant-1'
    public static readonly Email = 'owner@tenant.test'
    public static readonly PrincipalId = 'p-owner'
    public static readonly Current = 'owner-password-initial'
    public static readonly Next = 'owner-password-changed'
    public static readonly Wrong = 'not-the-owner-password'
    public static readonly IdpMaxAttempts = 5
    public static readonly AdminToken = 'tenant-plane-admin-token'
    public static readonly UserIp = '203.0.113.7'
    public static readonly OtherUserIp = '203.0.113.8'

    public static async WithIdp(body: (conn: IdpConnection, realm: IdpRealm, sso: IdpSsoSessionStore) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-password-client-'))
        let host: IdpHost | undefined
        try
        {
            const key = await IdpSigningKey.LoadOrCreate(path.join(dir, 'idp-signing.pem'))
            const ca = DevCa.EnsureAt(path.join(dir, 'ca'), 'localhost')
            const tls = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile })
            const realm = await IdpRealm.OpenFor(path.join(dir, 'realms'), PasswordClientFixture.TenantId, 'T', randomBytes(32))
            await realm.SeedAccount(PasswordClientFixture.Email, PasswordClientFixture.PrincipalId, PasswordClientFixture.Current, 'Owner')
            const sso = new IdpSsoSessionStore()
            const realms = new IdpRealmSet([[PasswordClientFixture.TenantId, realm]])
            const clients = new IdpClientStore()
            host = new IdpHost('https://localhost', key, realms, clients,
                new InMemoryAuthorizationCodeStore(), sso, tls, true, new IdpAdminEndpoint([PasswordClientFixture.AdminToken], realms, clients, sso))
            await host.Listen(0, '127.0.0.1')
            const baseUrl = 'https://localhost:' + host.Address().port
            const conn: IdpConnection = { baseUrl, browserBaseUrl: baseUrl, ca: fs.readFileSync(ca.caFile), adminToken: PasswordClientFixture.AdminToken, adminTokenRef: 'unused', caDir: path.join(dir, 'ca') }
            await body(conn, realm, sso)
        }
        finally
        {
            await host?.Close()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }
}

test('a right current password changes it at the IdP: the new one authenticates, the old one no longer does', async () =>
{
    await PasswordClientFixture.WithIdp(async (conn, realm) =>
    {
        const outcome = await new IdpPasswordClient().ChangePassword(conn, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next, PasswordClientFixture.UserIp)
        assert.equal(outcome.Result, IdpPasswordResult.Changed)
        assert.ok(await realm.Authenticate(PasswordClientFixture.Email, PasswordClientFixture.Next))
        assert.equal(await realm.Authenticate(PasswordClientFixture.Email, PasswordClientFixture.Current), null)
    })
})

test('a wrong current password is WrongPassword and changes nothing', async () =>
{
    await PasswordClientFixture.WithIdp(async (conn, realm) =>
    {
        const outcome = await new IdpPasswordClient().ChangePassword(conn, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Wrong, PasswordClientFixture.Next, PasswordClientFixture.UserIp)
        assert.equal(outcome.Result, IdpPasswordResult.WrongPassword)
        assert.ok(await realm.Authenticate(PasswordClientFixture.Email, PasswordClientFixture.Current))
    })
})

test('the client relays the end user address with the admin credential: the IdP throttles that user, not every user of the plane', async () =>
{
    await PasswordClientFixture.WithIdp(async conn =>
    {
        const client = new IdpPasswordClient()
        for (let i = 0; i < PasswordClientFixture.IdpMaxAttempts; i++)
        {
            await client.ChangePassword(conn, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Wrong, PasswordClientFixture.Next, PasswordClientFixture.UserIp)
        }
        const outcome = await client.ChangePassword(conn, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next, PasswordClientFixture.UserIp)
        assert.equal(outcome.Result, IdpPasswordResult.Throttled)
        assert.ok(outcome.RetryAfterSeconds !== undefined && outcome.RetryAfterSeconds > 0)
        const other = await client.ChangePassword(conn, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next, PasswordClientFixture.OtherUserIp)
        assert.equal(other.Result, IdpPasswordResult.Changed, 'another address of the same user is not locked')
    })
})

test('without the right admin credential the relayed address is ignored: every attempt counts against the plane address', async () =>
{
    await PasswordClientFixture.WithIdp(async conn =>
    {
        const client = new IdpPasswordClient()
        const wrongToken = { ...conn, adminToken: 'not-the-admin-token' }
        for (let i = 0; i < PasswordClientFixture.IdpMaxAttempts; i++)
        {
            await client.ChangePassword(wrongToken, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Wrong, PasswordClientFixture.Next, '198.51.100.' + String(i + 1))
        }
        const outcome = await client.ChangePassword(wrongToken, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next, PasswordClientFixture.OtherUserIp)
        assert.equal(outcome.Result, IdpPasswordResult.Throttled)
    })
})

test('an IdP with an untrusted certificate, an unknown realm, an unreachable IdP, or a non-https base url is Failed', async () =>
{
    await PasswordClientFixture.WithIdp(async conn =>
    {
        const client = new IdpPasswordClient()
        const otherCaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'other-ca-'))
        try
        {
            const untrusted = { ...conn, ca: fs.readFileSync(DevCa.EnsureAt(otherCaDir, 'localhost').caFile) }
            assert.equal((await client.ChangePassword(untrusted, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next, PasswordClientFixture.UserIp)).Result, IdpPasswordResult.Failed)
        }
        finally
        {
            fs.rmSync(otherCaDir, { recursive: true, force: true })
        }
        assert.equal((await client.ChangePassword(conn, 'no-such-tenant', PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next, PasswordClientFixture.UserIp)).Result, IdpPasswordResult.Failed)
        const closed = { ...conn, baseUrl: 'https://localhost:1' }
        assert.equal((await client.ChangePassword(closed, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next, PasswordClientFixture.UserIp)).Result, IdpPasswordResult.Failed)
        const plain = { ...conn, baseUrl: conn.baseUrl.replace('https:', 'http:') }
        assert.equal((await client.ChangePassword(plain, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next, PasswordClientFixture.UserIp)).Result, IdpPasswordResult.Failed)
    })
})
