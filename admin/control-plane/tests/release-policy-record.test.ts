import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReleasePolicyRegistry } from '../release-policy-record.js'
import type { ReleasePolicyRecord } from '../release-policy-record.js'
import
{
    ManifestWithdrawnError,
    TenantOnHoldError,
    ChannelNotSubscribedError,
    VersionBelowFloorError,
} from '../rollout-errors.js'

class PolicyFixture
{
    public static readonly Prefix = 'policy-'
    public static readonly FileName = 'release-policies.json'
    public static readonly TenantId = 'tenant-a'
    public static readonly Version = '1.2.3'
    public static readonly FloorOne = '1.0.0'
    public static readonly FloorTwo = '2.0.0'

    public static Record(minVersion: string): ReleasePolicyRecord
    {
        return { id: PolicyFixture.TenantId, tenantId: PolicyFixture.TenantId, minVersion }
    }
}

test('Put then Get and List return the record; same id replaces', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), PolicyFixture.Prefix))
    try
    {
        const registry = new ReleasePolicyRegistry(join(dir, PolicyFixture.FileName))
        await registry.Load()
        const first = PolicyFixture.Record(PolicyFixture.FloorOne)
        await registry.Put(first)
        assert.deepEqual(registry.Get(PolicyFixture.TenantId), first)
        assert.deepEqual(registry.List(), [first])
        const second = PolicyFixture.Record(PolicyFixture.FloorTwo)
        await registry.Put(second)
        assert.deepEqual(registry.Get(PolicyFixture.TenantId), second)
        assert.equal(registry.List().length, 1)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('policy errors carry name and id in message', () =>
{
    const v = PolicyFixture.Version
    const cases: Array<[Error, string]> = [
        [new ManifestWithdrawnError(v), 'ManifestWithdrawnError'],
        [new TenantOnHoldError(v), 'TenantOnHoldError'],
        [new ChannelNotSubscribedError(v), 'ChannelNotSubscribedError'],
        [new VersionBelowFloorError(v), 'VersionBelowFloorError'],
    ]
    for (const [error, name] of cases)
    {
        assert.equal(error.name, name)
        assert.ok(error.message.includes(v))
    }
})
