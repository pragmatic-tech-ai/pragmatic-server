import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TenantSessionStore } from '../tenant-auth/tenant-session.js'

class SessionFixture
{
    public static readonly Prefix = 'tenantsess-'
    public static readonly FileName = 'sessions.json'
    public static readonly Tenant = 'acme-prod'
    public static readonly Principal = 'user-1'
    public static readonly Email = 'a@acme.test'
    public static readonly Ttl = 60000
    public static readonly Unknown = 'nope'
    public static readonly Start = 1000000

    public static async WithDir(body: (file: string) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), SessionFixture.Prefix))
        try
        {
            await body(join(dir, SessionFixture.FileName))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }
}

test('Issue then Validate round-trips the session', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const store = new TenantSessionStore(file, SessionFixture.Ttl)
        const issued = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal, SessionFixture.Email)
        const found = await store.Validate(issued.id)
        assert.equal(found?.tenantId, SessionFixture.Tenant)
        assert.equal(found?.principalId, SessionFixture.Principal)
        assert.equal(found?.email, SessionFixture.Email)
    })
})

test('Validate of an unknown token is null', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const store = new TenantSessionStore(file, SessionFixture.Ttl)
        assert.equal(await store.Validate(SessionFixture.Unknown), null)
    })
})

test('Validate after Revoke is null', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const store = new TenantSessionStore(file, SessionFixture.Ttl)
        const issued = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        await store.Revoke(issued.id)
        assert.equal(await store.Validate(issued.id), null)
    })
})

test('An expired session is null', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        let clock = SessionFixture.Start
        const store = new TenantSessionStore(file, SessionFixture.Ttl, () => new Date(clock))
        const issued = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        assert.notEqual(await store.Validate(issued.id), null)
        clock += SessionFixture.Ttl + 1
        assert.equal(await store.Validate(issued.id), null)
    })
})

test('Sessions persist across store instances', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const first = new TenantSessionStore(file, SessionFixture.Ttl)
        const issued = await first.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        const second = new TenantSessionStore(file, SessionFixture.Ttl)
        assert.equal((await second.Validate(issued.id))?.principalId, SessionFixture.Principal)
    })
})
