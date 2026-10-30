import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManifestRegistry } from '../manifest-record.js'
import { GatingRegistry } from '../gating-record.js'
import { SelectionRegistry } from '../selection-record.js'
import { RolloutRegistrationRegistry } from '../rollout-registration-record.js'
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
    public static readonly GatingKey = 'gating'
    public static readonly SelectionsKey = 'selections'
    public static readonly RegistrationsKey = 'rolloutRegistrations'
    public static readonly Stamp = '2026-10-22T00:00:00.000Z'

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

test('GatingRegistry, SelectionRegistry and RolloutRegistrationRegistry persist under their own root keys', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), RolloutFixture.Prefix))
    try
    {
        const gatingFile = join(dir, 'gating.json')
        const selectionsFile = join(dir, 'selections.json')
        const registrationsFile = join(dir, 'registrations.json')
        const gating = new GatingRegistry(gatingFile)
        const selections = new SelectionRegistry(selectionsFile)
        const registrations = new RolloutRegistrationRegistry(registrationsFile)
        await gating.Put({ id: 't1:1.2.3', tenantId: 't1', version: '1.2.3', gatedAt: RolloutFixture.Stamp })
        await selections.Put({ id: 'hive-1', hiveId: 'hive-1', targetVersion: '1.2.3', selectedAt: RolloutFixture.Stamp })
        await registrations.Put({ id: 'hive-1', hiveId: 'hive-1', agentTokenHash: 'h', registeredAt: RolloutFixture.Stamp })
        const cases: [string, string, string][] = [[gatingFile, RolloutFixture.GatingKey, 't1:1.2.3'], [selectionsFile, RolloutFixture.SelectionsKey, 'hive-1'], [registrationsFile, RolloutFixture.RegistrationsKey, 'hive-1']]
        for (const [file, key, id] of cases)
        {
            const parsed = JSON.parse(await readFile(file, RolloutFixture.Encoding))
            assert.deepEqual(Object.keys(parsed), [key])
            assert.ok(id in parsed[key])
        }
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
