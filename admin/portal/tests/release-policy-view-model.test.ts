import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FleetViewModel } from '../src/fleet-view-model.js'
import { ReleasePolicyViewModel } from '../src/release-policy-view-model.js'
import { PillTone } from '../src/kit/tones.js'
import type { ClientDto, EnvRolloutDto, FleetHiveDto, GatingDto, HiveRolloutDto, SelectionDto, TenantDto } from '../src/portal-types.js'

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

    public static Env(environmentName: string, obsolete: boolean, ready: boolean, runningImage?: string): EnvRolloutDto
    {
        return { environmentName, obsolete, ready, runningImage }
    }

    public static Rollout(hiveId: string, targetVersion: string | undefined, environments: EnvRolloutDto[]): HiveRolloutDto
    {
        return { hiveId, targetVersion, environments }
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
        assert.deepEqual(
            [...raised].sort(),
            [ReleasePolicyViewModel.GatedRowsProperty, ReleasePolicyViewModel.TargetRowsProperty].sort())
    })

    it('keeps the unknown-hive owner label in sync with FleetViewModel', () =>
    {
        const ownerless = { ...Fx.Hive('h1', 'H'), client: null, tenant: null } as unknown as FleetHiveDto
        const vm = new ReleasePolicyViewModel([], [Fx.Sel('gone', '2.0', '2026-02-03')], tenants, clients, [])
        assert.equal(FleetViewModel.OwnerLabel(ownerless), vm.TargetRows[0].ownerLabel)
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

describe('ReleasePolicyViewModel rollout rows', () =>
{
    const hives = [Fx.Hive('h1', 'Hive One'), Fx.Hive('h2', 'Alpha')]

    class Make
    {
        public static Vm(rollouts: HiveRolloutDto[]): ReleasePolicyViewModel
        {
            return new ReleasePolicyViewModel([], [], [], [], hives, rollouts)
        }
    }

    it('marks an obsolete env as Behind target (Warning)', () =>
    {
        const vm = Make.Vm([Fx.Rollout('h1', '2.0', [Fx.Env('prod', true, true, 'img:1')])])
        assert.equal(vm.RolloutRows[0].statusLabel, 'Behind target')
        assert.equal(vm.RolloutRows[0].statusTone, PillTone.Warning)
        assert.equal(vm.RolloutRows[0].hiveName, 'Hive One')
        assert.equal(vm.RolloutRows[0].ownerLabel, 'Client / Tenant')
        assert.equal(vm.RolloutRows[0].envName, 'prod')
        assert.equal(vm.RolloutRows[0].targetLabel, '2.0')
        assert.equal(vm.RolloutRows[0].runningLabel, 'img:1')
    })

    it('marks a current ready env as On target (Success)', () =>
    {
        const vm = Make.Vm([Fx.Rollout('h1', '2.0', [Fx.Env('prod', false, true, 'i')])])
        assert.equal(vm.RolloutRows[0].statusLabel, 'On target')
        assert.equal(vm.RolloutRows[0].statusTone, PillTone.Success)
    })

    it('marks a current but unready env as Not ready (Warning)', () =>
    {
        const vm = Make.Vm([Fx.Rollout('h1', '2.0', [Fx.Env('prod', false, false, 'i')])])
        assert.equal(vm.RolloutRows[0].statusLabel, 'Not ready')
        assert.equal(vm.RolloutRows[0].statusTone, PillTone.Warning)
    })

    it('marks No target (Neutral) regardless of env flags', () =>
    {
        const vm = Make.Vm([Fx.Rollout('h1', undefined, [Fx.Env('a', true, false, 'i'), Fx.Env('b', false, true, 'i')])])
        assert.deepEqual(vm.RolloutRows.map(r => r.statusLabel), ['No target', 'No target'])
        assert.deepEqual(vm.RolloutRows.map(r => r.statusTone), [PillTone.Neutral, PillTone.Neutral])
        assert.equal(vm.RolloutRows[0].targetLabel, 'No target')
    })

    it('labels a missing running image as Not reported', () =>
    {
        const vm = Make.Vm([Fx.Rollout('h1', '2.0', [Fx.Env('prod', false, true)])])
        assert.equal(vm.RolloutRows[0].runningLabel, 'Not reported')
    })

    it('keeps a rollout whose hive is not in the fleet', () =>
    {
        const vm = Make.Vm([Fx.Rollout('gone', '2.0', [Fx.Env('prod', false, true, 'i')])])
        assert.equal(vm.RolloutRows.length, 1)
        assert.equal(vm.RolloutRows[0].hiveName, '(unknown hive)')
        assert.equal(vm.RolloutRows[0].ownerLabel, '(unassigned)')
    })

    it('flattens envs to rows sorted by hive then env', () =>
    {
        const vm = Make.Vm([
            Fx.Rollout('h1', '2.0', [Fx.Env('z', false, true, 'i'), Fx.Env('a', false, true, 'i')]),
            Fx.Rollout('h2', '2.0', [Fx.Env('m', false, true, 'i')]),
        ])
        assert.deepEqual(vm.RolloutRows.map(r => r.hiveName + '/' + r.envName), ['Alpha/m', 'Hive One/a', 'Hive One/z'])
    })

    it('orders envs of the same hive by env name', () =>
    {
        const vm = Make.Vm([Fx.Rollout('h1', '2.0', [Fx.Env('prod', false, true, 'i'), Fx.Env('canary', false, true, 'i')])])
        assert.deepEqual(vm.RolloutRows.map(r => r.envName), ['canary', 'prod'])
    })

    it('is empty with no rollouts, and the 5-arg ctor/Update still work', () =>
    {
        const vm = new ReleasePolicyViewModel([], [], [], [], [])
        assert.equal(vm.RolloutRows.length, 0)
        vm.Update([], [], [], [], [])
        assert.equal(vm.RolloutRows.length, 0)
    })

    it('Update replaces rollout rows and raises RolloutRows', () =>
    {
        const vm = Make.Vm([])
        let raised = 0
        vm.PropertyChanged(ReleasePolicyViewModel.RolloutRowsProperty).subscribe(() => { raised++ })
        vm.Update([], [], [], [], hives, [Fx.Rollout('h1', '2.0', [Fx.Env('prod', false, true, 'i')])])
        assert.equal(vm.RolloutRows.length, 1)
        assert.equal(raised, 1)
    })
})
