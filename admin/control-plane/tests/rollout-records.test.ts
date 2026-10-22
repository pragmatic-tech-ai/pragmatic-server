import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManifestRegistry } from '../manifest-record.js'
import type { ManifestRecord } from '../manifest-record.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord } from '../platform-records.js'

class RolloutFixture
{
    public static readonly Prefix = 'rollout-'
    public static readonly FileName = 'manifests.json'
    public static readonly MissingFileName = 'none.json'
    public static readonly Encoding = 'utf8'
    public static readonly RootKey = 'manifests'
    public static readonly Unknown = 'nope'
    public static readonly TokenRef = 'secret://agent-token'

    public static Manifest(): ManifestRecord
    {
        return { id: '1.2.3', image: 'registry/pragmatic-server:1.2.3', notes: 'first', publishedAt: '2026-10-22T00:00:00.000Z' }
    }

    public static Hive(): HiveRecord
    {
        return { id: 'hive-1', tenantId: 'acme-prod', displayName: 'Hive One', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach }, agentTokenRef: RolloutFixture.TokenRef, createdAt: '2026-10-22T00:00:00.000Z' }
    }
}

test('ManifestRegistry Put then Get round-trips and unknown id is undefined', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), RolloutFixture.Prefix))
    try
    {
        const reg = new ManifestRegistry(join(dir, RolloutFixture.FileName))
        await reg.Load()
        await reg.Put(RolloutFixture.Manifest())
        assert.deepEqual(reg.Get('1.2.3'), RolloutFixture.Manifest())
        assert.equal(reg.Get(RolloutFixture.Unknown), undefined)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('ManifestRegistry on a never-written path lists empty', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), RolloutFixture.Prefix))
    try
    {
        const reg = new ManifestRegistry(join(dir, RolloutFixture.MissingFileName))
        await reg.Load()
        assert.deepEqual(reg.List(), [])
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('ManifestRegistry persists JSON under the manifests root key', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), RolloutFixture.Prefix))
    try
    {
        const file = join(dir, RolloutFixture.FileName)
        const reg = new ManifestRegistry(file)
        await reg.Load()
        await reg.Put(RolloutFixture.Manifest())
        const parsed = JSON.parse(await readFile(file, RolloutFixture.Encoding))
        assert.ok(Array.isArray(parsed[RolloutFixture.RootKey]) || typeof parsed[RolloutFixture.RootKey] === 'object')
        assert.ok(RolloutFixture.RootKey in parsed)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('HiveRecord may carry agentTokenRef', () =>
{
    assert.equal(RolloutFixture.Hive().agentTokenRef, RolloutFixture.TokenRef)
})
