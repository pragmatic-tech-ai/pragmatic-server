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
            host = new IdpHost('https://localhost', key, new IdpRealmSet([[PasswordClientFixture.TenantId, realm]]), new IdpClientStore(),
                new InMemoryAuthorizationCodeStore(), sso, tls, true)
            await host.Listen(0, '127.0.0.1')
            const baseUrl = 'https://localhost:' + host.Address().port
            const conn: IdpConnection = { baseUrl, browserBaseUrl: baseUrl, ca: fs.readFileSync(ca.caFile), adminToken: 'unused', adminTokenRef: 'unused', caDir: path.join(dir, 'ca') }
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
        const outcome = await new IdpPasswordClient().ChangePassword(conn, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next)
        assert.equal(outcome.Result, IdpPasswordResult.Changed)
        assert.ok(await realm.Authenticate(PasswordClientFixture.Email, PasswordClientFixture.Next))
        assert.equal(await realm.Authenticate(PasswordClientFixture.Email, PasswordClientFixture.Current), null)
    })
})

test('a wrong current password is WrongPassword and changes nothing', async () =>
{
    await PasswordClientFixture.WithIdp(async (conn, realm) =>
    {
        const outcome = await new IdpPasswordClient().ChangePassword(conn, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Wrong, PasswordClientFixture.Next)
        assert.equal(outcome.Result, IdpPasswordResult.WrongPassword)
        assert.ok(await realm.Authenticate(PasswordClientFixture.Email, PasswordClientFixture.Current))
    })
})

test('once the IdP throttles, the outcome is Throttled with its Retry-After seconds', async () =>
{
    await PasswordClientFixture.WithIdp(async conn =>
    {
        const client = new IdpPasswordClient()
        for (let i = 0; i < PasswordClientFixture.IdpMaxAttempts; i++)
        {
            await client.ChangePassword(conn, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Wrong, PasswordClientFixture.Next)
        }
        const outcome = await client.ChangePassword(conn, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next)
        assert.equal(outcome.Result, IdpPasswordResult.Throttled)
        assert.ok(outcome.RetryAfterSeconds !== undefined && outcome.RetryAfterSeconds > 0)
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
            assert.equal((await client.ChangePassword(untrusted, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next)).Result, IdpPasswordResult.Failed)
        }
        finally
        {
            fs.rmSync(otherCaDir, { recursive: true, force: true })
        }
        assert.equal((await client.ChangePassword(conn, 'no-such-tenant', PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next)).Result, IdpPasswordResult.Failed)
        const closed = { ...conn, baseUrl: 'https://localhost:1' }
        assert.equal((await client.ChangePassword(closed, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next)).Result, IdpPasswordResult.Failed)
        const plain = { ...conn, baseUrl: conn.baseUrl.replace('https:', 'http:') }
        assert.equal((await client.ChangePassword(plain, PasswordClientFixture.TenantId, PasswordClientFixture.Email, PasswordClientFixture.Current, PasswordClientFixture.Next)).Result, IdpPasswordResult.Failed)
    })
})
