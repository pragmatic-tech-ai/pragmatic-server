import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ReleasePolicyViewModel } from '../src/release-policy-view-model.js'
import type { ClientDto, FleetHiveDto, GatingDto, SelectionDto, TenantDto } from '../src/portal-types.js'

class Fx
{
    public static Client(id: string, displayName: string): ClientDto
    {
        return { id, displayName } as ClientDto
    }

    public static Tenant(id: string, clientId: string, displayName: string): TenantDto
    {
        return { id, clientId, displayName } as TenantDto
    }

    public static Gate(tenantId: string, version: string, gatedAt: string): GatingDto
    {
        return { tenantId, version, gatedAt } as GatingDto
    }

    public static Sel(hiveId: string, targetVersion: string, selectedAt: string): SelectionDto
    {
        return { hiveId, targetVersion, selectedAt } as SelectionDto
    }

    public static Hive(id: string, displayName: string): FleetHiveDto
    {
        return {
            id,
            displayName,
            tenant: { id: 't1', displayName: 'Tenant' },
            client: { id: 'c1', displayName: 'Client' },
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen: null,
            environments: [],
        } as FleetHiveDto
    }
}

describe('ReleasePolicyViewModel', () =>
{
    const clients = [Fx.Client('c1', 'Client')]
    const tenants = [Fx.Tenant('t1', 'c1', 'Tenant'), Fx.Tenant('t2', 'missing', 'Orphan')]

    it('labels a gate for a known tenant and client', () =>
    {
        const vm = new ReleasePolicyViewModel([Fx.Gate('t1', '1.0', '2026-01-02T00:00:00Z')], [], tenants, clients, [])
        assert.equal(vm.GatedRows[0].ownerLabel, 'Client / Tenant')
        assert.equal(vm.GatedRows[0].version, '1.0')
        assert.equal(vm.GatedRows[0].gatedLabel, '2026-01-02')
    })

    it('labels a gate with no matching tenant as (unknown)', () =>
    {
        const vm = new ReleasePolicyViewModel([Fx.Gate('zzz', '1.0', '2026-01-02')], [], tenants, clients, [])
        assert.equal(vm.GatedRows[0].ownerLabel, '(unknown)')
    })

    it('labels a gate whose client is missing with just the tenant name', () =>
    {
        const vm = new ReleasePolicyViewModel([Fx.Gate('t2', '1.0', '2026-01-02')], [], tenants, clients, [])
        assert.equal(vm.GatedRows[0].ownerLabel, 'Orphan')
    })

    it('resolves a selection for a fleet hive', () =>
    {
        const vm = new ReleasePolicyViewModel([], [Fx.Sel('h1', '2.0', '2026-02-03')], tenants, clients, [Fx.Hive('h1', 'Hive One')])
        assert.equal(vm.TargetRows[0].hiveName, 'Hive One')
        assert.equal(vm.TargetRows[0].ownerLabel, 'Client / Tenant')
        assert.equal(vm.TargetRows[0].targetVersion, '2.0')
        assert.equal(vm.TargetRows[0].selectedLabel, '2026-02-03')
    })

    it('keeps a selection whose hive is not in the fleet', () =>
    {
        const vm = new ReleasePolicyViewModel([], [Fx.Sel('gone', '2.0', '2026-02-03')], tenants, clients, [])
        assert.equal(vm.TargetRows.length, 1)
        assert.equal(vm.TargetRows[0].hiveName, '(unknown hive)')
        assert.equal(vm.TargetRows[0].ownerLabel, '(unassigned)')
    })

    it('labels missing dates as Unknown', () =>
    {
        const vm = new ReleasePolicyViewModel([Fx.Gate('t1', '1.0', '')], [Fx.Sel('h1', '2.0', '')], tenants, clients, [Fx.Hive('h1', 'H')])
        assert.equal(vm.GatedRows[0].gatedLabel, 'Unknown')
        assert.equal(vm.TargetRows[0].selectedLabel, 'Unknown')
    })

    it('Update replaces both row sets and raises both keys', () =>
    {
        const vm = new ReleasePolicyViewModel([Fx.Gate('t1', '1.0', '2026-01-01')], [Fx.Sel('h1', '2.0', '2026-01-01')], tenants, clients, [Fx.Hive('h1', 'H')])
        const raised: string[] = []
        vm.PropertyChanged(ReleasePolicyViewModel.GatedRowsProperty).subscribe(() => { raised.push(ReleasePolicyViewModel.GatedRowsProperty) })
        vm.PropertyChanged(ReleasePolicyViewModel.TargetRowsProperty).subscribe(() => { raised.push(ReleasePolicyViewModel.TargetRowsProperty) })
        vm.Update([Fx.Gate('t2', '3.0', '2026-03-01'), Fx.Gate('t1', '3.1', '2026-03-01')], [], tenants, clients, [])
        assert.equal(vm.GatedRows.length, 2)
        assert.equal(vm.TargetRows.length, 0)
        assert.ok(raised.includes(ReleasePolicyViewModel.GatedRowsProperty))
        assert.ok(raised.includes(ReleasePolicyViewModel.TargetRowsProperty))
    })

    it('orders gated by owner then version and targets by hive', () =>
    {
        const vm = new ReleasePolicyViewModel(
            [Fx.Gate('t2', '1.0', 'x'), Fx.Gate('t1', '2.0', 'x'), Fx.Gate('t1', '1.0', 'x')],
            [Fx.Sel('b', '1', 'x'), Fx.Sel('a', '1', 'x')],
            tenants, clients, [Fx.Hive('a', 'Alpha'), Fx.Hive('b', 'Beta')])
        assert.deepEqual(vm.GatedRows.map(r => r.ownerLabel + '@' + r.version), ['Client / Tenant@1.0', 'Client / Tenant@2.0', 'Orphan@1.0'])
        assert.deepEqual(vm.TargetRows.map(r => r.hiveName), ['Alpha', 'Beta'])
    })
})
