import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HiveRegistry } from '../hive-registry.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord } from '../platform-records.js'

class HiveFixture
{
    public static readonly Prefix = 'hivereg-'
    public static readonly FileName = 'hives.json'
    public static readonly MissingFileName = 'none.json'
    public static readonly Malformed = '{ not json'
    public static readonly Encoding = 'utf8'

    public static Record(): HiveRecord
    {
        return { id: 'hive-1', tenantId: 'acme-prod', displayName: 'Hive One', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach }, createdAt: '2026-10-22T00:00:00.000Z' }
    }
}

test('Load on a missing file yields an empty list', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), HiveFixture.Prefix))
    try
    {
        const reg = new HiveRegistry(join(dir, HiveFixture.MissingFileName))
        await reg.Load()
        assert.equal(reg.List().length, 0)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Put then Load round-trips the record', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), HiveFixture.Prefix))
    const file = join(dir, HiveFixture.FileName)
    try
    {
        const rec = HiveFixture.Record()
        await new HiveRegistry(file).Put(rec)
        const reg = new HiveRegistry(file)
        await reg.Load()
        assert.deepEqual(reg.Get(rec.id), rec)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Remove deletes and persists', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), HiveFixture.Prefix))
    const file = join(dir, HiveFixture.FileName)
    try
    {
        const rec = HiveFixture.Record()
        const first = new HiveRegistry(file)
        await first.Put(rec)
        await first.Remove(rec.id)
        const reg = new HiveRegistry(file)
        await reg.Load()
        assert.equal(reg.Get(rec.id), undefined)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Load on malformed JSON throws (not silent-empty)', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), HiveFixture.Prefix))
    const file = join(dir, HiveFixture.FileName)
    try
    {
        await writeFile(file, HiveFixture.Malformed, HiveFixture.Encoding)
        await assert.rejects(new HiveRegistry(file).Load())
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
