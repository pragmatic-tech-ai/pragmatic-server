import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditRegistry } from '../audit-record.js'
import type { AuditRecord } from '../audit-record.js'

class ObservedAudit extends AuditRegistry
{
    public writes = 0
    public failNext = false
    public delayMs = 0

    protected override async WriteText(text: string): Promise<void>
    {
        this.writes++
        if (this.delayMs > 0)
        {
            await new Promise(r => setTimeout(r, this.delayMs))
        }
        if (this.failNext)
        {
            this.failNext = false
            throw new Error(BatchFixture.FailMessage)
        }
        await super.WriteText(text)
    }
}

class BatchFixture
{
    public static readonly Prefix = 'audit-batch-'
    public static readonly FileName = 'audit.json'
    public static readonly FailMessage = 'disk full'
    public static readonly Cap = 1000
    public static readonly Many = 50
    public static readonly BaseMs = Date.UTC(2026, 0, 1)
    public static readonly SlowMs = 20

    public static Entry(n: number, actor = 'op@example.com'): Omit<AuditRecord, 'id'>
    {
        return { actor, method: 'POST', path: `/p/${n}`, status: 200, at: new Date(BatchFixture.BaseMs + n * 1000).toISOString() }
    }

    public static async Make(): Promise<{ reg: ObservedAudit; file: string }>
    {
        const dir = await mkdtemp(join(tmpdir(), BatchFixture.Prefix))
        const file = join(dir, BatchFixture.FileName)
        const reg = new ObservedAudit(file)
        await reg.Load()
        return { reg, file }
    }

    public static async OnDisk(file: string): Promise<AuditRecord[]>
    {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as { audit: Record<string, AuditRecord> }
        return Object.values(parsed.audit)
    }
}

test('concurrent Appends coalesce into at most two writes and all land on disk', async () =>
{
    const { reg, file } = await BatchFixture.Make()
    reg.delayMs = BatchFixture.SlowMs
    await Promise.all(Array.from({ length: BatchFixture.Many }, (_, i) => reg.Append(BatchFixture.Entry(i))))
    assert.ok(reg.writes >= 1 && reg.writes <= 2, `writes=${reg.writes}`)
    assert.equal((await BatchFixture.OnDisk(file)).length, BatchFixture.Many)
})

test('over the cap evicts anonymous first in the same write and file holds exactly the cap', async () =>
{
    const { reg, file } = await BatchFixture.Make()
    await Promise.all(Array.from({ length: BatchFixture.Cap }, (_, i) => reg.Append(BatchFixture.Entry(i, i < 3 ? AuditRegistry.AnonymousActor : 'op@example.com'))))
    const before = reg.writes
    await reg.Append(BatchFixture.Entry(BatchFixture.Cap))
    await reg.Append(BatchFixture.Entry(BatchFixture.Cap + 1))
    assert.equal(reg.writes - before, 2)
    const disk = await BatchFixture.OnDisk(file)
    assert.equal(disk.length, BatchFixture.Cap)
    assert.equal(disk.filter(r => r.actor === AuditRegistry.AnonymousActor).length, 1)
    assert.equal(reg.List().length, BatchFixture.Cap)
})

test('a failed write rejects waiting Appends and the next Append persists everything', async () =>
{
    const { reg, file } = await BatchFixture.Make()
    reg.delayMs = 5
    reg.failNext = true
    const results = await Promise.allSettled([reg.Append(BatchFixture.Entry(1)), reg.Append(BatchFixture.Entry(2))])
    assert.ok(results.some(r => r.status === 'rejected'))
    assert.equal(reg.List().length, 2)
    await reg.Append(BatchFixture.Entry(3))
    assert.equal((await BatchFixture.OnDisk(file)).length, 3)
})

test('Append resolves only after its entry is on disk, and reads see it immediately', async () =>
{
    const { reg, file } = await BatchFixture.Make()
    reg.delayMs = BatchFixture.SlowMs
    const pending = reg.Append(BatchFixture.Entry(1))
    assert.equal(reg.Recent(10).length, 1)
    await pending
    assert.equal((await BatchFixture.OnDisk(file)).length, 1)
    const second = reg.Append(BatchFixture.Entry(2))
    const third = reg.Append(BatchFixture.Entry(3))
    await second
    assert.ok((await BatchFixture.OnDisk(file)).length >= 2)
    await third
    assert.equal((await BatchFixture.OnDisk(file)).length, 3)
})
