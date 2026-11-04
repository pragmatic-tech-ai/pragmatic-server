import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TenantSessionKind, TenantSessionStore } from '../tenant-auth/tenant-session.js'

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

test('A session whose expiresAt equals now is rejected', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        let clock = SessionFixture.Start
        const store = new TenantSessionStore(file, SessionFixture.Ttl, () => new Date(clock))
        const issued = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        clock += SessionFixture.Ttl
        assert.equal(await store.Validate(issued.id), null)
    })
})

test('Overlapping Issue calls all persist', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const store = new TenantSessionStore(file, SessionFixture.Ttl)
        const all = await Promise.all([1, 2, 3, 4, 5].map(() => store.Issue(SessionFixture.Tenant, SessionFixture.Principal)))
        const fresh = new TenantSessionStore(file, SessionFixture.Ttl)
        for (const s of all)
        {
            assert.notEqual(await fresh.Validate(s.id), null)
        }
    })
})

test('Concurrent first calls do not resurrect a revoked session', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const seed = new TenantSessionStore(file, SessionFixture.Ttl)
        const issued = await seed.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        const store = new TenantSessionStore(file, SessionFixture.Ttl)
        const revoke = store.Revoke(issued.id)
        const validate = store.Validate(issued.id)
        await Promise.all([revoke, validate])
        assert.equal(await store.Validate(issued.id), null)
    })
})

test('A corrupt file throws a message that leaks nothing', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        await writeFile(file, '{"sessions": {"SECRETTOKEN": ')
        const store = new TenantSessionStore(file, SessionFixture.Ttl)
        await assert.rejects(store.Validate(SessionFixture.Unknown), (err: Error) => !err.message.includes('SECRETTOKEN'))
    })
})

test('Issue prunes expired sessions from the file', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        let clock = SessionFixture.Start
        const store = new TenantSessionStore(file, SessionFixture.Ttl, () => new Date(clock))
        const old = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        clock += SessionFixture.Ttl * 2
        await store.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        assert.ok(!(await readFile(file, 'utf8')).includes(old.id))
    })
})

test('RevokeAllFor ends every session of the principal in the tenant (persisted), and only those', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const store = new TenantSessionStore(file, SessionFixture.Ttl)
        const a = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        const b = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        const other = await store.Issue(SessionFixture.Tenant, 'user-2')
        const elsewhere = await store.Issue('other-tenant', SessionFixture.Principal)
        assert.equal(await store.RevokeAllFor(SessionFixture.Tenant, SessionFixture.Principal), 2)
        assert.equal(await store.Validate(a.id), null)
        assert.equal(await store.Validate(b.id), null)
        assert.notEqual(await store.Validate(other.id), null)
        assert.notEqual(await store.Validate(elsewhere.id), null)
        const reloaded = new TenantSessionStore(file, SessionFixture.Ttl)
        assert.equal(await reloaded.Validate(a.id), null)
        assert.notEqual(await reloaded.Validate(other.id), null)
        assert.equal(await store.RevokeAllFor(SessionFixture.Tenant, SessionFixture.Principal), 0)
    })
})

test('a session issued before the principal\'s reset time is refused, even one that reappears (persisted stamp; legacy sessions too)', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        let nowMs = SessionFixture.Start
        const clock = (): Date => new Date(nowMs)
        const store = new TenantSessionStore(file, SessionFixture.Ttl, clock)
        const before = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        assert.equal(before.issuedAt, new Date(SessionFixture.Start).toISOString())
        nowMs += 10
        await store.RevokeAllFor(SessionFixture.Tenant, SessionFixture.Principal)
        // The revoked session comes back (e.g. an older file restored, or a write that raced the revoke) - plus a legacy
        // session without issuedAt (derived from expiresAt - ttl): both predate the reset, both are refused.
        const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, Record<string, unknown>>
        raw.sessions[before.id] = before
        raw.sessions['legacy'] = { id: 'legacy', tenantId: SessionFixture.Tenant, principalId: SessionFixture.Principal, expiresAt: new Date(SessionFixture.Start + SessionFixture.Ttl).toISOString() }
        await writeFile(file, JSON.stringify(raw))
        const reloaded = new TenantSessionStore(file, SessionFixture.Ttl, clock)
        assert.equal(await reloaded.Validate(before.id), null)
        assert.equal(await reloaded.Validate('legacy'), null)
        // After the reset: a new session validates; other principals are unaffected.
        nowMs += 10
        const after = await reloaded.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        assert.notEqual(await reloaded.Validate(after.id), null)
        const someoneElse = await reloaded.Issue(SessionFixture.Tenant, 'user-2')
        assert.notEqual(await reloaded.Validate(someoneElse.id), null)
    })
})

test('RotateFor ends every session of the principal, the caller\'s too, and issues one fresh session that the reset does not refuse (persisted)', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const nowMs = SessionFixture.Start
        const clock = (): Date => new Date(nowMs)
        const store = new TenantSessionStore(file, SessionFixture.Ttl, clock)
        // The same instant as the rotation: the fresh session must survive its own reset stamp.
        const mine = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal, 'me@t.test')
        const other = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal, 'me@t.test')
        const someoneElse = await store.Issue(SessionFixture.Tenant, 'user-2')
        const fresh = await store.RotateFor(SessionFixture.Tenant, SessionFixture.Principal, 'me@t.test')
        assert.notEqual(fresh.id, mine.id)
        assert.equal(fresh.email, 'me@t.test')
        assert.equal(await store.Validate(mine.id), null)
        assert.equal(await store.Validate(other.id), null)
        assert.notEqual(await store.Validate(fresh.id), null)
        assert.notEqual(await store.Validate(someoneElse.id), null)
        const reloaded = new TenantSessionStore(file, SessionFixture.Ttl, clock)
        assert.notEqual(await reloaded.Validate(fresh.id), null)
        assert.equal(await reloaded.Validate(mine.id), null)
    })
})

test('a later full reset ends the rotated session too', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        let nowMs = SessionFixture.Start
        const clock = (): Date => new Date(nowMs)
        const store = new TenantSessionStore(file, SessionFixture.Ttl, clock)
        const fresh = await store.RotateFor(SessionFixture.Tenant, SessionFixture.Principal)
        nowMs += 10
        await store.RevokeAllFor(SessionFixture.Tenant, SessionFixture.Principal)
        assert.equal(await store.Validate(fresh.id), null)
    })
})

test('a grant whose write fails leaves memory and disk as they were: rotate and issue are strict', async () =>
{
    const root = await mkdtemp(join(tmpdir(), 'tenant-session-atomic-'))
    const sub = join(root, 'sub')
    const file = join(sub, 'tenant-sessions.json')
    try
    {
        const store = new TenantSessionStore(file, SessionFixture.Ttl)
        const mine = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal, 'me@t.test')
        const other = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal, 'me@t.test')
        // Make every further write fail: the store's directory becomes a plain file.
        await rm(sub, { recursive: true, force: true })
        await writeFile(sub, 'blocked')
        await assert.rejects(store.RotateFor(SessionFixture.Tenant, SessionFixture.Principal, 'me@t.test'))
        await assert.rejects(store.Issue(SessionFixture.Tenant, SessionFixture.Principal))
        assert.notEqual(await store.Validate(mine.id), null, 'the caller keeps its valid session')
        assert.notEqual(await store.Validate(other.id), null, 'nothing was ended in memory either')
        // Writes work again: the rotation lands, and a restart (reload from disk) agrees.
        await rm(sub, { force: true })
        const fresh = await store.RotateFor(SessionFixture.Tenant, SessionFixture.Principal, 'me@t.test')
        const reloaded = new TenantSessionStore(file, SessionFixture.Ttl)
        assert.equal(await reloaded.Validate(mine.id), null)
        assert.equal(await reloaded.Validate(other.id), null)
        assert.notEqual(await reloaded.Validate(fresh.id), null)
    }
    finally
    {
        await rm(root, { recursive: true, force: true })
    }
})

test('concurrent changes are serialised: none is lost', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const store = new TenantSessionStore(file, SessionFixture.Ttl)
        const issued = await Promise.all(Array.from({ length: 5 }, (_, i) => store.Issue(SessionFixture.Tenant, 'user-' + i)))
        const reloaded = new TenantSessionStore(file, SessionFixture.Ttl)
        for (const session of issued)
        {
            assert.notEqual(await reloaded.Validate(session.id), null)
        }
    })
})

test('a revocation whose write fails still takes effect at once (fail closed); the next successful write carries it to disk', async () =>
{
    const root = await mkdtemp(join(tmpdir(), 'tenant-session-failclosed-'))
    const sub = join(root, 'sub')
    const file = join(sub, 'tenant-sessions.json')
    try
    {
        const store = new TenantSessionStore(file, SessionFixture.Ttl)
        const owner1 = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        const owner2 = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        const loggingOut = await store.Issue(SessionFixture.Tenant, 'user-2')
        const bystander = await store.Issue(SessionFixture.Tenant, 'user-3')
        await rm(sub, { recursive: true, force: true })
        await writeFile(sub, 'blocked')
        await assert.rejects(store.RevokeAllFor(SessionFixture.Tenant, SessionFixture.Principal))
        await assert.rejects(store.Revoke(loggingOut.id))
        assert.equal(await store.Validate(owner1.id), null, 'refused at once despite the failed write')
        assert.equal(await store.Validate(owner2.id), null)
        assert.equal(await store.Validate(loggingOut.id), null)
        assert.notEqual(await store.Validate(bystander.id), null)
        // Writes work again: the next change writes memory, revocations included.
        await rm(sub, { force: true })
        await store.Issue(SessionFixture.Tenant, 'user-4')
        const reloaded = new TenantSessionStore(file, SessionFixture.Ttl)
        assert.equal(await reloaded.Validate(owner1.id), null)
        assert.equal(await reloaded.Validate(owner2.id), null)
        assert.equal(await reloaded.Validate(loggingOut.id), null)
        assert.notEqual(await reloaded.Validate(bystander.id), null)
    }
    finally
    {
        await rm(root, { recursive: true, force: true })
    }
})

class DesktopFixture
{
    public static readonly Day = 24 * 60 * 60 * 1000
    public static readonly Hour = 60 * 60 * 1000
    public static readonly Minute = 60 * 1000
    public static Clock = 0

    public static Now(): Date
    {
        return new Date(DesktopFixture.Clock)
    }

    public static Store(file: string): TenantSessionStore
    {
        DesktopFixture.Clock = SessionFixture.Start
        return new TenantSessionStore(file, SessionFixture.Ttl, () => DesktopFixture.Now())
    }

    public static async OnDisk(file: string, id: string): Promise<{ expiresAt: string; keptAt?: string; kind?: string }>
    {
        return JSON.parse(await readFile(file, 'utf8')).sessions[id]
    }
}

test('issues a desktop session that lives 7 days', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const store = DesktopFixture.Store(file)
        const s = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal, SessionFixture.Email, TenantSessionKind.Desktop)
        assert.equal(new Date(s.expiresAt).getTime() - new Date(s.issuedAt as string).getTime(), 7 * DesktopFixture.Day)
        assert.equal(s.kind, 'desktop')
        assert.equal((await store.Validate(s.id))?.kind, TenantSessionKind.Desktop)
    })
})

test('slides a desktop session on use, at most once per hour, never past 30 days', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const store = DesktopFixture.Store(file)
        const s = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal, undefined, TenantSessionKind.Desktop)
        const issuedMs = new Date(s.issuedAt as string).getTime()
        DesktopFixture.Clock = issuedMs + 2 * DesktopFixture.Hour
        const slid = await store.Validate(s.id)
        assert.equal(new Date(slid?.expiresAt as string).getTime(), DesktopFixture.Clock + 7 * DesktopFixture.Day)
        const first = await DesktopFixture.OnDisk(file, s.id)
        assert.equal(first.expiresAt, slid?.expiresAt)
        assert.equal(first.keptAt, new Date(DesktopFixture.Clock).toISOString())
        const bytes = await readFile(file, 'utf8')
        DesktopFixture.Clock += 10 * DesktopFixture.Minute
        const again = await store.Validate(s.id)
        assert.equal(again?.expiresAt, slid?.expiresAt)
        assert.equal(await readFile(file, 'utf8'), bytes)
        for (let at = 3 * DesktopFixture.Day; at < 29.9 * DesktopFixture.Day; at += 3 * DesktopFixture.Day)
        {
            DesktopFixture.Clock = issuedMs + at
            assert.notEqual(await store.Validate(s.id), null)
        }
        DesktopFixture.Clock = issuedMs + 29.9 * DesktopFixture.Day
        const late = await store.Validate(s.id)
        assert.ok(new Date(late?.expiresAt as string).getTime() <= issuedMs + 30 * DesktopFixture.Day)
        assert.equal(late?.expiresAt, new Date(issuedMs + 30 * DesktopFixture.Day).toISOString())
        DesktopFixture.Clock = issuedMs + 30 * DesktopFixture.Day + 1
        assert.equal(await store.Validate(s.id), null)
    })
})

test('does not slide a console session', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const store = DesktopFixture.Store(file)
        const s = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal)
        assert.equal(s.kind, undefined)
        DesktopFixture.Clock += 30000
        const seen = await store.Validate(s.id)
        assert.equal(seen?.expiresAt, s.expiresAt)
        assert.equal((await DesktopFixture.OnDisk(file, s.id)).keptAt, undefined)
    })
})

test('ends desktop sessions with RevokeAllFor and RotateFor', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const store = DesktopFixture.Store(file)
        const a = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal, undefined, TenantSessionKind.Desktop)
        assert.equal(await store.RevokeAllFor(SessionFixture.Tenant, SessionFixture.Principal), 1)
        assert.equal(await store.Validate(a.id), null)
        DesktopFixture.Clock += 5
        const b = await store.Issue(SessionFixture.Tenant, SessionFixture.Principal, undefined, TenantSessionKind.Desktop)
        DesktopFixture.Clock += 5
        const fresh = await store.RotateFor(SessionFixture.Tenant, SessionFixture.Principal)
        assert.equal(await store.Validate(b.id), null)
        assert.equal(fresh.kind, undefined)
        assert.notEqual(await store.Validate(fresh.id), null)
    })
})

test('loads a file written before session kinds existed as console sessions', async () =>
{
    await SessionFixture.WithDir(async file =>
    {
        const old = { id: 'old-token', tenantId: SessionFixture.Tenant, principalId: SessionFixture.Principal, issuedAt: new Date(SessionFixture.Start).toISOString(), expiresAt: new Date(SessionFixture.Start + SessionFixture.Ttl).toISOString() }
        await writeFile(file, JSON.stringify({ sessions: { 'old-token': old }, principalResets: {} }), 'utf8')
        const store = DesktopFixture.Store(file)
        DesktopFixture.Clock += 30000
        const seen = await store.Validate('old-token')
        assert.equal(seen?.kind, undefined)
        assert.equal(seen?.expiresAt, old.expiresAt)
        assert.equal((await DesktopFixture.OnDisk(file, 'old-token')).keptAt, undefined)
    })
})
