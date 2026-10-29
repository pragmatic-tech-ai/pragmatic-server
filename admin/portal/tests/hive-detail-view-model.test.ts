import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveDetailViewModel } from '../src/hive-detail-view-model.js'
import { PortalDates } from '../src/portal-dates.js'
import { FleetConnection } from '../src/fleet-view-model.js'
import { BannerTone, PillKinds } from '../src/kit/index.js'
import { FleetPresentation } from '../src/fleet-presentation.js'
import type { FleetHiveDto } from '../src/portal-types.js'

class Fx
{
    public static readonly Now = new Date('2026-10-28T12:00:00.000Z')
    public static readonly HourMs = 60 * 60 * 1000

    public static Ago(ms: number): string
    {
        return new Date(Fx.Now.getTime() - ms).toISOString()
    }

    public static Hive(lastSeen: string | null, environments: object[]): FleetHiveDto
    {
        return {
            id: 'h1',
            displayName: 'Hive One',
            tenant: { id: 't1', displayName: 'Tenant One' },
            client: { id: 'c1', displayName: 'Client One' },
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen,
            environments,
        } as FleetHiveDto
    }

    public static Vm(hive: FleetHiveDto): HiveDetailViewModel
    {
        return new HiveDetailViewModel(hive, () => Fx.Now)
    }
}

describe('HiveDetailViewModel', () =>
{
    it('shows a warning banner and home channel for a quiet hive', () =>
    {
        const vm = Fx.Vm(Fx.Hive(Fx.Ago(48 * Fx.HourMs), []))
        assert.equal(vm.Connection, FleetConnection.Quiet)
        assert.equal(vm.Banner.show, true)
        assert.equal(vm.Banner.tone, BannerTone.Warning)
        assert.ok(vm.Banner.text.includes('Hive One'))
        assert.ok(vm.Banner.text.includes('nothing to retry'))
        assert.deepEqual(vm.HomeChannel.map(i => i.key), ['Client / tenant', 'Connection', 'Last check-in', 'Cluster', 'Environments observed'])
        const quietLabel = PillKinds.For(FleetPresentation.ConnectionKind(FleetConnection.Quiet)).label
        assert.equal(vm.HomeChannel[1].value, quietLabel)
        assert.notEqual(vm.HomeChannel[1].value, vm.HomeChannel[2].value)
        assert.equal(vm.HomeChannel[0].value, vm.OwnerLabel)
        assert.equal(vm.OwnerLabel, 'Client One / Tenant One')
    })

    it('shows an info banner and no envs for an awaiting hive', () =>
    {
        const vm = Fx.Vm(Fx.Hive(null, []))
        assert.equal(vm.Connection, FleetConnection.Awaiting)
        assert.equal(vm.Banner.show, true)
        assert.equal(vm.Banner.tone, BannerTone.Info)
        assert.equal(vm.EnvRows.length, 0)
    })

    it('hides the banner and maps envs for a connected hive', () =>
    {
        const vm = Fx.Vm(Fx.Hive(Fx.Ago(Fx.HourMs), [
            { name: 'a', ready: false, image: 'img:1', detail: 'down' },
            { name: 'b', ready: true, detail: '' },
        ]))
        assert.equal(vm.Connection, FleetConnection.Connected)
        assert.equal(vm.Banner.show, false)
        assert.equal(vm.EnvRows.length, 2)
        assert.equal(vm.EnvRows[0].ready, false)
        assert.equal(vm.EnvRows[1].image, '-')
        assert.equal(vm.Cluster, 'k8s / managed')
        const connectedLabel = PillKinds.For(FleetPresentation.ConnectionKind(FleetConnection.Connected)).label
        assert.equal(vm.HomeChannel[1].value, connectedLabel)
    })

    it('derives observation history rows newest-first with a ready summary', () =>
    {
        const obs = [
            { id: 'o2', hiveId: 'h1', reportedAt: Fx.Ago(Fx.HourMs), environments: [{ environmentName: 'a', ready: true, detail: '' }, { environmentName: 'b', ready: false, detail: '' }] },
            { id: 'o1', hiveId: 'h1', reportedAt: Fx.Ago(2 * Fx.HourMs), environments: [{ environmentName: 'a', ready: true, detail: '' }] },
        ]
        const vm = new HiveDetailViewModel(Fx.Hive(null, []), () => Fx.Now, undefined, obs)
        assert.equal(vm.ObservationHistory.length, 2)
        assert.equal(vm.ObservationHistory[0].summaryLabel, '1/2 ready')
        assert.equal(vm.ObservationHistory[1].summaryLabel, '1/1 ready')
        assert.equal(vm.ObservationHistory[0].whenLabel, PortalDates.Label(obs[0].reportedAt))
    })

    it('derives ledger rows newest-first with friendly action labels', () =>
    {
        const ledger = [
            { id: 'l3', version: '1.2.0', action: 'gated', at: Fx.Ago(Fx.HourMs) },
            { id: 'l2', version: '1.1.0', action: 'adopted', at: Fx.Ago(2 * Fx.HourMs) },
            { id: 'l1', version: '1.0.0', action: 'mystery', at: Fx.Ago(3 * Fx.HourMs) },
        ]
        const vm = new HiveDetailViewModel(Fx.Hive(null, []), () => Fx.Now, undefined, [], ledger)
        assert.equal(vm.LedgerHistory.length, 3)
        assert.equal(vm.LedgerHistory[0].actionLabel, 'Gated')
        assert.equal(vm.LedgerHistory[0].version, '1.2.0')
        assert.equal(vm.LedgerHistory[0].whenLabel, PortalDates.Label(ledger[0].at))
        assert.equal(vm.LedgerHistory[1].actionLabel, 'Adopted')
        assert.equal(vm.LedgerHistory[2].actionLabel, 'mystery')
    })

    it('has empty ledger history by default', () =>
    {
        assert.equal(Fx.Vm(Fx.Hive(null, [])).LedgerHistory.length, 0)
    })

    it('has empty observation history by default', () =>
    {
        assert.equal(Fx.Vm(Fx.Hive(null, [])).ObservationHistory.length, 0)
    })

    it('exposes the hive effective policy labels', () =>
    {
        const policy = { tenantId: 't1', hiveId: 'h1', channels: ['stable' as const], minVersion: '2.0.0', hold: { reason: 'r', actor: 'a', at: Fx.Now.toISOString() } }
        const vm = new HiveDetailViewModel(Fx.Hive(null, []), () => Fx.Now, undefined, [], [], policy)
        assert.deepEqual(vm.HivePolicy, { channelsLabel: 'stable', minVersionLabel: '2.0.0', heldLabel: 'Held', held: true })
    })

    it('defaults the hive policy when none is supplied', () =>
    {
        assert.deepEqual(Fx.Vm(Fx.Hive(null, [])).HivePolicy, { channelsLabel: 'Inherits tenant', minVersionLabel: 'Inherits tenant', heldLabel: 'No per-hive hold', held: false })
    })

    it('labels an empty channel set as all channels', () =>
    {
        const vm = new HiveDetailViewModel(Fx.Hive(null, []), () => Fx.Now, undefined, [], [], { tenantId: 't1', hiveId: 'h1', channels: [] })
        assert.equal(vm.HivePolicy.channelsLabel, 'Inherits tenant')
    })
})
