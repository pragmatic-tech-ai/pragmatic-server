import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FleetConnection, FleetIssueKind, FleetSegment, FleetViewModel } from '../src/fleet-view-model.js'
import type { FleetHiveDto } from '../src/portal-types.js'

class Fx
{
    public static readonly Now = new Date('2026-10-28T12:00:00.000Z')
    public static readonly Threshold = 6 * 60 * 60 * 1000

    public static Ago(ms: number): string
    {
        return new Date(Fx.Now.getTime() - ms).toISOString()
    }

    public static Hive(id: string, lastSeen: string | null, ready: boolean[] = [true]): FleetHiveDto
    {
        return {
            id,
            displayName: id,
            tenant: { id: 't', displayName: 'Tenant' },
            client: { id: 'c', displayName: 'Client' },
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen,
            environments: ready.map((r, i) => ({ name: 'env' + i, ready: r, detail: '' })),
        } as FleetHiveDto
    }

    public static Vm(rows: FleetHiveDto[]): FleetViewModel
    {
        return new FleetViewModel(rows, () => Fx.Now)
    }
}

describe('FleetViewModel', () =>
{
    it('null lastSeen is Awaiting with Never dialled in', () =>
    {
        const row = Fx.Vm([Fx.Hive('a', null)]).Rows[0]
        assert.equal(row.connection, FleetConnection.Awaiting)
        assert.equal(row.lastSeenLabel, 'Never dialled in')
        assert.ok(row.issues.some(i => i.kind === FleetIssueKind.Awaiting))
    })

    it('threshold boundary splits Connected and Quiet', () =>
    {
        const ok = Fx.Vm([Fx.Hive('a', Fx.Ago(Fx.Threshold - 60000))]).Rows[0]
        assert.equal(ok.connection, FleetConnection.Connected)
        assert.equal(ok.issues.length, 0)
        const quiet = Fx.Vm([Fx.Hive('b', Fx.Ago(Fx.Threshold + 60000))]).Rows[0]
        assert.equal(quiet.connection, FleetConnection.Quiet)
        assert.ok(quiet.issues.some(i => i.kind === FleetIssueKind.Quiet))
    })

    it('not-ready env yields an EnvironmentNotReady issue', () =>
    {
        const row = Fx.Vm([Fx.Hive('a', Fx.Ago(1000), [true, false])]).Rows[0]
        assert.equal(row.notReadyCount, 1)
        assert.equal(row.envCount, 2)
        assert.equal(row.issues.filter(i => i.kind === FleetIssueKind.EnvironmentNotReady).length, 1)
    })

    it('NeedsAttention excludes healthy and orders danger before warning', () =>
    {
        const vm = Fx.Vm([
            Fx.Hive('healthy', Fx.Ago(1000)),
            Fx.Hive('quiet', Fx.Ago(Fx.Threshold + 60000)),
            Fx.Hive('broken', Fx.Ago(1000), [false]),
        ])
        assert.deepEqual(vm.NeedsAttention.map(r => r.id), ['broken', 'quiet'])
    })

    it('tile counts on a mixed set', () =>
    {
        const vm = Fx.Vm([
            Fx.Hive('healthy', Fx.Ago(1000), [true, true]),
            Fx.Hive('quiet', Fx.Ago(Fx.Threshold + 60000), [true]),
            Fx.Hive('awaiting', null, [false]),
        ])
        assert.equal(vm.HiveCount, 3)
        assert.equal(vm.NeedAttentionCount, 2)
        assert.equal(vm.NotCheckingInCount, 2)
        assert.equal(vm.EnvironmentsObserved, 4)
    })

    it('NotCheckingIn segment shows quiet and awaiting rows', () =>
    {
        const vm = Fx.Vm([
            Fx.Hive('healthy', Fx.Ago(1000)),
            Fx.Hive('quiet', Fx.Ago(Fx.Threshold + 60000)),
            Fx.Hive('awaiting', null),
        ])
        assert.equal(vm.Visible().length, 3)
        vm.SetSegment(FleetSegment.NotCheckingIn)
        assert.deepEqual(vm.Visible().map(r => r.id), ['quiet', 'awaiting'])
        assert.equal(vm.Segment, FleetSegment.NotCheckingIn)
    })

    it('null client and tenant give a safe ownerLabel', () =>
    {
        const dto = { ...Fx.Hive('a', null), client: null, tenant: null } as FleetHiveDto
        const row = Fx.Vm([dto]).Rows[0]
        assert.ok(row.ownerLabel.length > 0)
    })

    it('OwnerLabel joins client and tenant, falls back to the present one, then unassigned', () =>
    {
        const hive = (client: string | null, tenant: string | null): FleetHiveDto => ({
            client: client ? { id: 'c', displayName: client } : null,
            tenant: tenant ? { id: 't', displayName: tenant } : null,
        }) as FleetHiveDto
        assert.equal(FleetViewModel.OwnerLabel(hive('Client', 'Tenant')), 'Client / Tenant')
        assert.equal(FleetViewModel.OwnerLabel(hive('Client', null)), 'Client')
        assert.equal(FleetViewModel.OwnerLabel(hive(null, 'Tenant')), 'Tenant')
        assert.equal(FleetViewModel.OwnerLabel(hive(null, null)), '(unassigned)')
    })
})
