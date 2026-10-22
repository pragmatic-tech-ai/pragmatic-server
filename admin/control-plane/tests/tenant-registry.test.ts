import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TenantRegistry } from '../tenant-registry.js'
import type { TenantRecord } from '../platform-records.js'

class TenantFixture
{
    public static readonly Prefix = 'tenantreg-'
    public static readonly FileName = 'tenants.json'
    public static readonly MissingFileName = 'none.json'
    public static readonly Malformed = '{ not json'
    public static readonly Encoding = 'utf8'

    public static Record(): TenantRecord
    {
        return { id: 'acme-prod', clientId: 'acme', displayName: 'Acme Prod', createdAt: '2026-10-22T00:00:00.000Z' }
    }
}

test('Load on a missing file yields an empty list', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), TenantFixture.Prefix))
    try
    {
        const reg = new TenantRegistry(join(dir, TenantFixture.MissingFileName))
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
    const dir = await mkdtemp(join(tmpdir(), TenantFixture.Prefix))
    const file = join(dir, TenantFixture.FileName)
    try
    {
        const rec = TenantFixture.Record()
        await new TenantRegistry(file).Put(rec)
        const reg = new TenantRegistry(file)
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
    const dir = await mkdtemp(join(tmpdir(), TenantFixture.Prefix))
    const file = join(dir, TenantFixture.FileName)
    try
    {
        const rec = TenantFixture.Record()
        const first = new TenantRegistry(file)
        await first.Put(rec)
        await first.Remove(rec.id)
        const reg = new TenantRegistry(file)
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
    const dir = await mkdtemp(join(tmpdir(), TenantFixture.Prefix))
    const file = join(dir, TenantFixture.FileName)
    try
    {
        await writeFile(file, TenantFixture.Malformed, TenantFixture.Encoding)
        await assert.rejects(new TenantRegistry(file).Load())
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
