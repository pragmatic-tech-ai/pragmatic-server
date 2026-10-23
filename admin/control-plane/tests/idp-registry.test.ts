import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdpRegistry } from '../idp-registry.js'
import { IdpStatus, type IdpRecord } from '../idp-record.js'

class IdpRecordFixture
{
    public static readonly FileName = 'idps.json'
    public static readonly TempPrefix = 'idp-registry-'

    public static Record(tenantId: string, port: number, status: IdpStatus = IdpStatus.Running): IdpRecord
    {
        return {
            tenantId,
            port,
            baseUrl: `https://localhost:${port}`,
            containerName: `idp-${tenantId}`,
            volumeName: `idp-${tenantId}-data`,
            caDir: `/ca/${tenantId}`,
            adminTokenRef: `${tenantId}.admin-token`,
            createdAt: '2026-10-23T00:00:00.000Z',
            status
        }
    }
}

test('Put then Get returns the record', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), IdpRecordFixture.TempPrefix))
    try
    {
        const registry = new IdpRegistry(join(dir, IdpRecordFixture.FileName))
        const record = IdpRecordFixture.Record('acme', 8443)
        await registry.Put(record)
        assert.deepEqual(registry.Get('acme'), record)
        assert.equal(registry.Get('missing'), undefined)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('List returns all records', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), IdpRecordFixture.TempPrefix))
    try
    {
        const registry = new IdpRegistry(join(dir, IdpRecordFixture.FileName))
        await registry.Put(IdpRecordFixture.Record('acme', 8443))
        await registry.Put(IdpRecordFixture.Record('globex', 8444, IdpStatus.Failed))
        const tenants = registry.List().map(r => r.tenantId).sort()
        assert.deepEqual(tenants, ['acme', 'globex'])
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Load on a reopened file returns persisted records', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), IdpRecordFixture.TempPrefix))
    try
    {
        const path = join(dir, IdpRecordFixture.FileName)
        const record = IdpRecordFixture.Record('acme', 8443)
        await new IdpRegistry(path).Put(record)
        const reopened = new IdpRegistry(path)
        await reopened.Load()
        assert.deepEqual(reopened.Get('acme'), record)
        assert.equal(reopened.List().length, 1)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Delete removes a record and persists the removal', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), IdpRecordFixture.TempPrefix))
    try
    {
        const path = join(dir, IdpRecordFixture.FileName)
        const registry = new IdpRegistry(path)
        await registry.Put(IdpRecordFixture.Record('acme', 8443))
        await registry.Delete('acme')
        assert.equal(registry.Get('acme'), undefined)
        const reopened = new IdpRegistry(path)
        await reopened.Load()
        assert.equal(reopened.Get('acme'), undefined)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Load on a missing file leaves the registry empty without throwing', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), IdpRecordFixture.TempPrefix))
    try
    {
        const registry = new IdpRegistry(join(dir, IdpRecordFixture.FileName))
        await registry.Load()
        assert.deepEqual(registry.List(), [])
        assert.equal(registry.Get('acme'), undefined)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('a second Put with the same tenantId overwrites the record', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), IdpRecordFixture.TempPrefix))
    try
    {
        const path = join(dir, IdpRecordFixture.FileName)
        const registry = new IdpRegistry(path)
        await registry.Put(IdpRecordFixture.Record('acme', 8443, IdpStatus.Running))
        await registry.Put(IdpRecordFixture.Record('acme', 9555, IdpStatus.Failed))
        assert.equal(registry.List().length, 1)
        assert.equal(registry.Get('acme')?.port, 9555)
        assert.equal(registry.Get('acme')?.status, IdpStatus.Failed)
        const reopened = new IdpRegistry(path)
        await reopened.Load()
        assert.equal(reopened.Get('acme')?.port, 9555)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
