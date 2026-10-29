import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdoptionLedgerRegistry } from '../adoption-ledger-record.js'

class Fx
{
    public static readonly Prefix = 'ledger-'
    public static readonly HiveA = 'hive-a'
    public static readonly HiveB = 'hive-b'
    public static readonly TenantA = 'tenant-a'
    public static readonly TenantB = 'tenant-b'
    public static readonly TickMs = 2

    public static async Run(body: (ledger: AdoptionLedgerRegistry, dir: string) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), Fx.Prefix))
        try
        {
            const ledger = new AdoptionLedgerRegistry(join(dir, 'l.json'))
            await ledger.Load()
            await body(ledger, dir)
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }

    public static Tick(): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, Fx.TickMs))
    }
}

test('ForHive and ForTenant filter, order newest-first, and honor the limit', async () =>
{
    await Fx.Run(async ledger =>
    {
        await ledger.Append({ hiveId: Fx.HiveA, tenantId: Fx.TenantA, version: '1.0.0', action: 'selected' })
        await Fx.Tick()
        await ledger.Append({ hiveId: Fx.HiveB, tenantId: Fx.TenantB, version: '1.0.0', action: 'adopted' })
        await Fx.Tick()
        await ledger.Append({ hiveId: Fx.HiveA, tenantId: Fx.TenantA, version: '2.0.0', action: 'adopted' })
        await Fx.Tick()
        await ledger.Append({ tenantId: Fx.TenantA, version: '2.0.0', action: 'gated' })
        const hive = ledger.ForHive(Fx.HiveA, 10)
        assert.deepEqual(hive.map(r => r.version), ['2.0.0', '1.0.0'])
        assert.equal(ledger.ForHive(Fx.HiveA, 1).length, 1)
        const tenant = ledger.ForTenant(Fx.TenantA, 10)
        assert.deepEqual(tenant.map(r => r.action), ['gated', 'adopted', 'selected'])
        assert.equal(ledger.ForTenant(Fx.TenantB, 10).length, 1)
        assert.deepEqual(ledger.ForHive('none', 10), [])
    })
})

test('Append assigns unique ids and an ISO timestamp', async () =>
{
    await Fx.Run(async ledger =>
    {
        await ledger.Append({ hiveId: Fx.HiveA, version: '1.0.0', action: 'selected' })
        await ledger.Append({ hiveId: Fx.HiveA, version: '1.0.0', action: 'selected' })
        const all = ledger.List()
        assert.equal(new Set(all.map(r => r.id)).size, 2)
        assert.ok(!Number.isNaN(Date.parse(all[0]!.at)))
    })
})

test('Append evicts the oldest entries beyond the cap', async () =>
{
    await Fx.Run(async (ledger, dir) =>
    {
        const cap = 2000
        const start = Date.parse('2026-01-01T00:00:00.000Z')
        const seeded: Record<string, unknown> = {}
        for (let i = 0; i < cap; i++)
        {
            seeded['seed-' + i] = { id: 'seed-' + i, hiveId: Fx.HiveA, version: 'v' + i, action: 'adopted', at: new Date(start + i).toISOString() }
        }
        await writeFile(join(dir, 'l.json'), JSON.stringify({ adoptionLedger: seeded }))
        await ledger.Load()
        await ledger.Append({ hiveId: Fx.HiveA, version: 'newest', action: 'adopted' })
        const all = ledger.List()
        assert.equal(all.length, cap)
        assert.equal(ledger.Get('seed-0'), undefined)
        assert.ok(ledger.Get('seed-1') !== undefined)
        assert.equal(ledger.ForHive(Fx.HiveA, 1)[0]?.version, 'newest')
    })
})
