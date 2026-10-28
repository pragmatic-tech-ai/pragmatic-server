import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveDetailViewModel } from '../src/hive-detail-view-model.js'
import { FleetConnection } from '../src/fleet-view-model.js'
import { BannerTone } from '../src/kit/index.js'
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
        assert.deepEqual(vm.HomeChannel.map(i => i.key), ['Connection', 'Last check-in', 'Cluster', 'Environments observed'])
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
    })
})
