import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleAdvertRegistry } from '../console-advert-registry.js'
import type { ConsoleAdvertRecord } from '../console-advert-registry.js'
import { ConsoleDomainApprovals } from '../console-domain-approvals.js'

const FpA = 'a'.repeat(64)
const FpB = 'b'.repeat(64)

class RegistryFixture
{
    public dir = ''
    public registry!: ConsoleAdvertRegistry

    public static async Run(body: (f: RegistryFixture) => Promise<void>): Promise<void>
    {
        const f = new RegistryFixture()
        f.dir = await mkdtemp(join(tmpdir(), 'advert-registry-'))
        f.registry = new ConsoleAdvertRegistry(join(f.dir, ConsoleAdvertRegistry.FileName))
        try
        {
            await body(f)
        }
        finally
        {
            await rm(f.dir, { recursive: true, force: true })
        }
    }

    public static Advert(over: Partial<Omit<ConsoleAdvertRecord, 'id' | 'firstReportedAt'>> = {}): Omit<ConsoleAdvertRecord, 'id' | 'firstReportedAt'>
    {
        return { tenantId: 'acme', hiveId: 'h1', consoleUrl: 'https://console-acme.localtest.me', fingerprints: [FpA], emailDomains: ['acme.test'], reportedAt: '2026-11-04T10:00:00.000Z', ...over }
    }
}

test('Report replaces the tenant advert and keeps the first report time', async () =>
{
    await RegistryFixture.Run(async f =>
    {
        await f.registry.Report(RegistryFixture.Advert())
        await f.registry.Report(RegistryFixture.Advert({ fingerprints: [FpB], reportedAt: '2026-11-04T11:00:00.000Z' }))
        assert.equal(f.registry.List().length, 1)
        const record = f.registry.ForTenant('acme') as ConsoleAdvertRecord
        assert.deepEqual(record.fingerprints, [FpB])
        assert.equal(record.firstReportedAt, '2026-11-04T10:00:00.000Z')
        assert.equal(record.reportedAt, '2026-11-04T11:00:00.000Z')
    })
})

test('a report from another hive restarts the first report time', async () =>
{
    await RegistryFixture.Run(async f =>
    {
        await f.registry.Report(RegistryFixture.Advert())
        await f.registry.Report(RegistryFixture.Advert({ hiveId: 'h2', reportedAt: '2026-11-04T11:00:00.000Z' }))
        assert.equal((f.registry.ForTenant('acme') as ConsoleAdvertRecord).firstReportedAt, '2026-11-04T11:00:00.000Z')
    })
})

test('HasFingerprint answers from the latest advert only', async () =>
{
    await RegistryFixture.Run(async f =>
    {
        await f.registry.Report(RegistryFixture.Advert())
        assert.equal(f.registry.HasFingerprint('acme', FpA), true)
        await f.registry.Report(RegistryFixture.Advert({ fingerprints: [FpB] }))
        assert.equal(f.registry.HasFingerprint('acme', FpA), false)
        assert.equal(f.registry.HasFingerprint('acme', FpB), true)
        assert.equal(f.registry.HasFingerprint('other', FpB), false)
    })
})

test('the advert and its fingerprints survive a reload', async () =>
{
    await RegistryFixture.Run(async f =>
    {
        await f.registry.Report(RegistryFixture.Advert())
        const again = new ConsoleAdvertRegistry(join(f.dir, ConsoleAdvertRegistry.FileName))
        await again.Load()
        assert.equal((again.ForTenant('acme') as ConsoleAdvertRecord).consoleUrl, 'https://console-acme.localtest.me')
        assert.equal(again.HasFingerprint('acme', FpA), true)
        assert.equal(again.All().length, 1)
    })
})

test('ForgetHive drops only that hive\'s advert', async () =>
{
    await RegistryFixture.Run(async f =>
    {
        await f.registry.Report(RegistryFixture.Advert())
        await f.registry.Report(RegistryFixture.Advert({ tenantId: 'beta', hiveId: 'h2' }))
        await f.registry.ForgetHive('h1')
        assert.equal(f.registry.ForTenant('acme'), undefined)
        assert.equal(f.registry.HasFingerprint('acme', FpA), false)
        assert.notEqual(f.registry.ForTenant('beta'), undefined)
    })
})

test('Report stores nothing when its admission check refuses at write time', async () =>
{
    await RegistryFixture.Run(async f =>
    {
        await f.registry.Report(RegistryFixture.Advert())
        assert.equal(await f.registry.Report(RegistryFixture.Advert({ fingerprints: [FpB] }), () => false), undefined)
        assert.deepEqual(f.registry.ForTenant('acme')?.fingerprints, [FpA])
        assert.equal(f.registry.HasFingerprint('acme', FpB), false)
    })
})

test('ForgetTenant drops the tenant\'s advert', async () =>
{
    await RegistryFixture.Run(async f =>
    {
        await f.registry.Report(RegistryFixture.Advert())
        await f.registry.ForgetTenant('acme')
        assert.equal(f.registry.List().length, 0)
        assert.equal(f.registry.HasFingerprint('acme', FpA), false)
    })
})

test('IsStale only after more than 24 hours', () =>
{
    const record = { reportedAt: '2026-11-04T10:00:00.000Z' } as ConsoleAdvertRecord
    const reported = Date.parse(record.reportedAt)
    assert.equal(ConsoleAdvertRegistry.IsStale(record, new Date(reported + ConsoleAdvertRegistry.StaleAfterMs)), false)
    assert.equal(ConsoleAdvertRegistry.IsStale(record, new Date(reported + ConsoleAdvertRegistry.StaleAfterMs + 1)), true)
})

test('operator approvals are separate from adverts, survive re-adverts and reload, and are forgotten per tenant', async () =>
{
    await RegistryFixture.Run(async f =>
    {
        const path = join(f.dir, ConsoleDomainApprovals.FileName)
        const approvals = new ConsoleDomainApprovals(path)
        await approvals.Approve('acme', ' Acme.TEST ')
        await approvals.Approve('acme', 'acme.test')
        await approvals.Approve('acme', 'eu.acme.test')
        assert.deepEqual(approvals.ApprovedFor('acme'), ['acme.test', 'eu.acme.test'])
        await f.registry.Report(RegistryFixture.Advert())
        await f.registry.Report(RegistryFixture.Advert({ emailDomains: [] }))
        assert.deepEqual(approvals.ApprovedFor('acme'), ['acme.test', 'eu.acme.test'])

        const again = new ConsoleDomainApprovals(path)
        await again.Load()
        assert.deepEqual(again.ApprovedFor('acme'), ['acme.test', 'eu.acme.test'])
        await again.Revoke('acme', 'acme.test')
        await again.Revoke('acme', 'never.test')
        assert.deepEqual(again.ApprovedFor('acme'), ['eu.acme.test'])
        await again.Revoke('acme', 'eu.acme.test')
        assert.deepEqual(again.ApprovedFor('acme'), [])
        assert.equal(again.List().length, 0)
        await again.Approve('acme', 'acme.test')
        await again.ForgetTenant('acme')
        assert.deepEqual(again.ApprovedFor('acme'), [])
    })
})

test('approving a refused domain throws', async () =>
{
    await RegistryFixture.Run(async f =>
    {
        const approvals = new ConsoleDomainApprovals(join(f.dir, ConsoleDomainApprovals.FileName))
        await assert.rejects(() => approvals.Approve('acme', 'gmail.com'), /public mail domain/)
        assert.deepEqual(approvals.ApprovedFor('acme'), [])
    })
})

test('EffectiveDomains is advertised intersect approved', () =>
{
    assert.deepEqual(ConsoleDomainApprovals.EffectiveDomains(['b.test', 'a.test', 'c.test', 'a.test'], ['a.test', 'c.test', 'z.test']), ['a.test', 'c.test'])
    assert.deepEqual(ConsoleDomainApprovals.EffectiveDomains(['a.test'], []), [])
    assert.deepEqual(ConsoleDomainApprovals.EffectiveDomains([], ['a.test']), [])
})

test('IsStale treats an unparseable reportedAt as stale', () =>
{
    assert.equal(ConsoleAdvertRegistry.IsStale({ reportedAt: 'garbage' } as ConsoleAdvertRecord, new Date()), true)
})

test('EffectiveDomains normalises both sides before intersecting', () =>
{
    assert.deepEqual(ConsoleDomainApprovals.EffectiveDomains([' Acme.TEST', 'b.test.'], ['acme.test.', 'B.TEST', 'z.test']), ['acme.test', 'b.test'])
})
