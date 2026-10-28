import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HivesViewModel } from '../src/hives-view-model.js'
import { FleetConnection } from '../src/fleet-view-model.js'
import type { FleetHiveDto } from '../src/portal-types.js'

class Fx
{
    public static readonly Now = new Date('2026-10-28T12:00:00.000Z')
    public static readonly HourMs = 60 * 60 * 1000

    public static Ago(ms: number): string
    {
        return new Date(Fx.Now.getTime() - ms).toISOString()
    }

    public static Hive(id: string, lastSeen: string | null, ready: boolean[]): FleetHiveDto
    {
        return {
            id,
            displayName: 'Hive ' + id,
            tenant: { id: 't-' + id, displayName: 'Tenant ' + id },
            client: { id: 'c-' + id, displayName: 'Client ' + id },
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen,
            environments: ready.map((r, i) => ({ name: 'env' + i, ready: r, detail: '' })),
        } as FleetHiveDto
    }

    public static Fleet(): FleetHiveDto[]
    {
        return [
            Fx.Hive('a', Fx.Ago(Fx.HourMs), [true, true]),
            Fx.Hive('b', Fx.Ago(10 * Fx.HourMs), [true, false, false]),
            Fx.Hive('c', null, []),
        ]
    }

    public static Vm(fleet: FleetHiveDto[]): HivesViewModel
    {
        return new HivesViewModel(fleet, () => Fx.Now)
    }
}

describe('HivesViewModel', () =>
{
    it('derives one row per hive in fleet order', () =>
    {
        const vm = Fx.Vm(Fx.Fleet())
        assert.equal(vm.Rows.length, 3)
        assert.deepEqual(vm.Rows.map(r => r.id), ['a', 'b', 'c'])
    })

    it('derives cluster, owner, connection and env counts', () =>
    {
        const rows = Fx.Vm(Fx.Fleet()).Rows
        assert.equal(rows[0].cluster, 'k8s / managed')
        assert.equal(rows[0].ownerLabel, 'Client a / Tenant a')
        assert.equal(rows[0].connection, FleetConnection.Connected)
        assert.equal(rows[0].envCount, 2)
        assert.equal(rows[0].notReadyCount, 0)
        assert.equal(rows[1].connection, FleetConnection.Quiet)
        assert.equal(rows[1].envCount, 3)
        assert.equal(rows[1].notReadyCount, 2)
        assert.equal(rows[2].connection, FleetConnection.Awaiting)
        assert.equal(rows[2].envCount, 0)
    })

    it('Update re-derives and raises RowsProperty', () =>
    {
        const vm = Fx.Vm(Fx.Fleet())
        let raised = 0
        vm.PropertyChanged(HivesViewModel.RowsProperty).subscribe(() => { raised++ })
        vm.Update([Fx.Hive('z', null, [false])])
        assert.equal(vm.Rows.length, 1)
        assert.equal(vm.Rows[0].id, 'z')
        assert.equal(vm.Rows[0].notReadyCount, 1)
        assert.equal(raised, 1)
    })
})
