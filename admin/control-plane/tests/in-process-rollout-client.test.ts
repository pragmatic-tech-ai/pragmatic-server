import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import type { AdoptionLedgerRecord } from '../adoption-ledger-record.js'
import { InProcessRolloutClient } from '../tenant-api/in-process-rollout-client.js'

class Names
{
    public static readonly HiveId = 'h1'
    public static readonly TenantId = 't1'
    public static readonly Version = '1.0.0'
    public static readonly At = '2026-01-01T00:00:00.000Z'
    public static readonly Limit = 10
    public static readonly TenantKey = 'tenantId'
}

describe('InProcessRolloutClient.LedgerFor', () =>
{
    it('maps ledger records to DTOs with no tenantId', async () =>
    {
        const records: AdoptionLedgerRecord[] = [{ id: 'r1', tenantId: Names.TenantId, hiveId: Names.HiveId, version: Names.Version, action: 'adopted', at: Names.At }]
        const seen: Array<[string, number]> = []
        const deployments = { LedgerForHive: (h: string, l: number) => { seen.push([h, l]); return records } } as unknown as PlatformDeploymentRegistry
        const dtos = await new InProcessRolloutClient(deployments).LedgerFor(Names.HiveId, Names.Limit)
        assert.deepEqual(seen, [[Names.HiveId, Names.Limit]])
        assert.equal(dtos.length, 1)
        assert.equal(dtos[0]!.version, Names.Version)
        assert.equal(dtos[0]!.action, 'adopted')
        assert.equal(dtos[0]!.at, Names.At)
        assert.ok(!(Names.TenantKey in dtos[0]!))
    })
})
