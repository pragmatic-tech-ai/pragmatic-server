import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditRegistry } from '../audit-record.js'
import type { AuditRecord } from '../audit-record.js'

class AuditFixture
{
    public static readonly Prefix = 'audit-'
    public static readonly FileName = 'audit.json'
    public static readonly Actor = 'op@example.com'
    public static readonly Method = 'POST'
    public static readonly Path = '/admin/x'
    public static readonly Cap = 1000
    public static readonly Extra = 5
    public static readonly Anon = AuditRegistry.AnonymousActor
    public static readonly BaseMs = Date.UTC(2026, 0, 1)

    public static Entry(n: number): Omit<AuditRecord, 'id'>
    {
        return { actor: AuditFixture.Actor, method: AuditFixture.Method, path: AuditFixture.Path, status: 200, at: new Date(AuditFixture.BaseMs + n * 1000).toISOString() }
    }

    public static Anonymous(n: number): Omit<AuditRecord, 'id'>
    {
        return { ...AuditFixture.Entry(n), actor: AuditFixture.Anon }
    }

    public static async Make(): Promise<{ reg: AuditRegistry; dir: string }>
    {
        const dir = await mkdtemp(join(tmpdir(), AuditFixture.Prefix))
        const reg = new AuditRegistry(join(dir, AuditFixture.FileName))
        await reg.Load()
        return { reg, dir }
    }
}

test('Recent returns newest first, limited', async () =>
{
    const { reg, dir } = await AuditFixture.Make()
    try
    {
        for (const n of [1, 3, 2])
        {
            await reg.Append(AuditFixture.Entry(n))
        }
        const recent = reg.Recent(2)
        assert.deepEqual(recent.map(r => r.at), [AuditFixture.Entry(3).at, AuditFixture.Entry(2).at])
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('each entry gets a unique non-empty id', async () =>
{
    const { reg, dir } = await AuditFixture.Make()
    try
    {
        for (const n of [1, 2, 3])
        {
            await reg.Append(AuditFixture.Entry(n))
        }
        const ids = reg.List().map(r => r.id)
        assert.ok(ids.every(i => i.length > 0))
        assert.equal(new Set(ids).size, 3)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('eviction keeps the newest MaxEntries', async () =>
{
    const { reg, dir } = await AuditFixture.Make()
    try
    {
        const total = AuditFixture.Cap + AuditFixture.Extra
        for (let n = 0; n < total; n++)
        {
            await reg.Append(AuditFixture.Entry(n))
        }
        assert.equal(reg.List().length, AuditFixture.Cap)
        const ats = new Set(reg.List().map(r => r.at))
        for (let n = 0; n < AuditFixture.Extra; n++)
        {
            assert.ok(!ats.has(AuditFixture.Entry(n).at))
        }
        assert.ok(ats.has(AuditFixture.Entry(total - 1).at))
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('eviction drops the oldest by timestamp, not by insertion order', async () =>
{
    const { reg, dir } = await AuditFixture.Make()
    try
    {
        for (let n = 1; n <= AuditFixture.Cap; n++)
        {
            await reg.Append(AuditFixture.Entry(n))
        }
        // Append one entry whose `at` is older than every stored entry, last. At the cap this
        // triggers eviction of the OLDEST-by-at (this new one), whereas FIFO would drop Entry(1).
        await reg.Append(AuditFixture.Entry(-1))
        const ats = new Set(reg.List().map(r => r.at))
        assert.equal(reg.List().length, AuditFixture.Cap)
        assert.ok(!ats.has(AuditFixture.Entry(-1).at))
        assert.ok(ats.has(AuditFixture.Entry(1).at))
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('anonymous flood never evicts authored history', async () =>
{
    const { reg, dir } = await AuditFixture.Make()
    try
    {
        await reg.Append(AuditFixture.Entry(0))
        for (let n = 1; n <= AuditFixture.Cap; n++)
        {
            await reg.Append(AuditFixture.Anonymous(n))
        }
        const ats = new Set(reg.List().map(r => r.at))
        assert.equal(reg.List().length, AuditFixture.Cap)
        assert.ok(ats.has(AuditFixture.Entry(0).at))
        assert.ok(!ats.has(AuditFixture.Entry(1).at))
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('mixed overflow keeps every authored entry and drops oldest anonymous first', async () =>
{
    const { reg, dir } = await AuditFixture.Make()
    try
    {
        const total = AuditFixture.Cap + AuditFixture.Extra
        const authored: number[] = []
        for (let n = 0; n < total; n++)
        {
            if (n % 10 === 0)
            {
                authored.push(n)
                await reg.Append(AuditFixture.Entry(n))
            }
            else
            {
                await reg.Append(AuditFixture.Anonymous(n))
            }
        }
        const ats = new Set(reg.List().map(r => r.at))
        assert.equal(reg.List().length, AuditFixture.Cap)
        for (const n of authored)
        {
            assert.ok(ats.has(AuditFixture.Entry(n).at))
        }
        // The oldest anonymous entries (n = 1..5) are the ones dropped.
        for (let n = 1; n <= AuditFixture.Extra; n++)
        {
            assert.ok(!ats.has(AuditFixture.Entry(n).at))
        }
        assert.ok(ats.has(AuditFixture.Entry(total - 1).at))
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('all-authored overflow stays bounded, dropping the oldest', async () =>
{
    const { reg, dir } = await AuditFixture.Make()
    try
    {
        const total = AuditFixture.Cap + AuditFixture.Extra
        for (let n = 0; n < total; n++)
        {
            await reg.Append(AuditFixture.Entry(n))
        }
        const ats = new Set(reg.List().map(r => r.at))
        assert.equal(reg.List().length, AuditFixture.Cap)
        for (let n = 0; n < AuditFixture.Extra; n++)
        {
            assert.ok(!ats.has(AuditFixture.Entry(n).at))
        }
        assert.ok(ats.has(AuditFixture.Entry(total - 1).at))
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
