import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientRegistry } from '../client-registry.js'
import type { ClientRecord } from '../platform-records.js'

class ClientFixture
{
    public static readonly Prefix = 'clientreg-'
    public static readonly FileName = 'clients.json'
    public static readonly MissingFileName = 'none.json'
    public static readonly Malformed = '{ not json'
    public static readonly Encoding = 'utf8'

    public static Record(): ClientRecord
    {
        return { id: 'acme', displayName: 'Acme Corp', subscriptionRef: 'sub-1', createdAt: '2026-10-22T00:00:00.000Z' }
    }
}

test('Load on a missing file yields an empty list', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), ClientFixture.Prefix))
    try
    {
        const reg = new ClientRegistry(join(dir, ClientFixture.MissingFileName))
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
    const dir = await mkdtemp(join(tmpdir(), ClientFixture.Prefix))
    const file = join(dir, ClientFixture.FileName)
    try
    {
        const rec = ClientFixture.Record()
        await new ClientRegistry(file).Put(rec)
        const reg = new ClientRegistry(file)
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
    const dir = await mkdtemp(join(tmpdir(), ClientFixture.Prefix))
    const file = join(dir, ClientFixture.FileName)
    try
    {
        const rec = ClientFixture.Record()
        const first = new ClientRegistry(file)
        await first.Put(rec)
        await first.Remove(rec.id)
        const reg = new ClientRegistry(file)
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
    const dir = await mkdtemp(join(tmpdir(), ClientFixture.Prefix))
    const file = join(dir, ClientFixture.FileName)
    try
    {
        await writeFile(file, ClientFixture.Malformed, ClientFixture.Encoding)
        await assert.rejects(new ClientRegistry(file).Load())
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
