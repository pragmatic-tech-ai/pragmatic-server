import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TenantAdminClientRegistry } from '../tenant-auth/tenant-admin-client-record.js'
import type { TenantAdminClientRecord } from '../tenant-auth/tenant-admin-client-record.js'

describe('TenantAdminClientRegistry', () =>
{
    const TempPrefix = 'tenant-admin-client-'
    const StoreFileName = 'clients.json'
    const TenantId = 't1'
    const Missing = 'nope'
    const FirstRef = 'r'
    const SecondRef = 'r2'
    const ClientId = 'c'
    const RotatedAt = '2026-01-01T00:00:00.000Z'

    let dir = ''
    let registry: TenantAdminClientRegistry

    const MakeRecord = (secretRef: string): TenantAdminClientRecord => ({
        id: TenantId,
        tenantId: TenantId,
        clientId: ClientId,
        secretRef,
        rotatedAt: RotatedAt
    })

    beforeEach(async () =>
    {
        dir = mkdtempSync(join(tmpdir(), TempPrefix))
        registry = new TenantAdminClientRegistry(join(dir, StoreFileName))
        await registry.Load()
    })

    afterEach(() =>
    {
        rmSync(dir, { recursive: true, force: true })
    })

    it('puts and gets a record', async () =>
    {
        const record = MakeRecord(FirstRef)
        await registry.Put(record)
        assert.deepEqual(registry.Get(TenantId), record)
        assert.equal(registry.Get(Missing), undefined)
    })

    it('overwrites on a second put rather than appending', async () =>
    {
        await registry.Put(MakeRecord(FirstRef))
        await registry.Put(MakeRecord(SecondRef))
        assert.equal(registry.Get(TenantId)?.secretRef, SecondRef)
        assert.equal(registry.List().length, 1)
    })

    it('persists across a reload: a fresh registry over the same file sees the record', async () =>
    {
        await registry.Put(MakeRecord(FirstRef))
        const reloaded = new TenantAdminClientRegistry(join(dir, StoreFileName))
        await reloaded.Load()
        assert.deepEqual(reloaded.Get(TenantId), MakeRecord(FirstRef))
    })
})
