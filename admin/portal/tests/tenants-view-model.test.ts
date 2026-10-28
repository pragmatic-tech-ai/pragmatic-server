import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TenantsViewModel } from '../src/tenants-view-model.js'
import { FleetConnection } from '../src/fleet-view-model.js'
import type { ClientDto, FleetHiveDto, TenantDto } from '../src/portal-types.js'

class Fx
{
    public static readonly Now = new Date('2026-10-28T12:00:00.000Z')
    public static readonly HourMs = 60 * 60 * 1000

    public static Ago(ms: number): string
    {
        return new Date(Fx.Now.getTime() - ms).toISOString()
    }

    public static Client(id: string): ClientDto
    {
        return { id, displayName: 'Client ' + id, createdAt: '2026-01-01T00:00:00.000Z' }
    }

    public static Tenant(id: string, clientId: string): TenantDto
    {
        return { id, clientId, displayName: 'Tenant ' + id, createdAt: '2026-02-02T00:00:00.000Z' }
    }

    public static Hive(id: string, tenantId: string | null, lastSeen: string | null, envs: number): FleetHiveDto
    {
        return {
            id,
            displayName: 'Hive ' + id,
            tenant: tenantId === null ? null : { id: tenantId, displayName: 'Tenant ' + tenantId },
            client: null,
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen,
            environments: Array.from({ length: envs }, (_, i) => ({ id: 'e' + i })),
        } as unknown as FleetHiveDto
    }

    public static Vm(fleet: FleetHiveDto[]): TenantsViewModel
    {
        return new TenantsViewModel(
            [Fx.Tenant('t1', 'a'), Fx.Tenant('t2', 'a'), Fx.Tenant('t3', 'zzz')],
            [Fx.Client('a')],
            fleet,
            () => Fx.Now,
        )
    }
}

describe('TenantsViewModel', () =>
{
    it('rolls up client, hive, connection and env count per tenant', () =>
    {
        const vm = Fx.Vm([
            Fx.Hive('h1', 't1', Fx.Ago(Fx.HourMs), 3),
            Fx.Hive('h9', 'other', Fx.Ago(Fx.HourMs), 5),
        ])
        assert.equal(vm.Rows.length, 3)
        const t1 = vm.Rows[0]
        assert.equal(t1.clientName, 'Client a')
        assert.equal(t1.hiveName, 'Hive h1')
        assert.equal(t1.connection, FleetConnection.Connected)
        assert.equal(t1.observedEnvCount, 3)
        assert.equal(t1.createdAt, '2026-02-02T00:00:00.000Z')
        const t2 = vm.Rows[1]
        assert.equal(t2.hiveName, 'No hive yet')
        assert.equal(t2.connection, FleetConnection.Awaiting)
        assert.equal(t2.lastSeenLabel, 'Awaiting first dial-in')
        assert.equal(t2.observedEnvCount, 0)
    })

    it('unknown client id falls back', () =>
    {
        assert.equal(Fx.Vm([]).Rows[2].clientName, '(unknown client)')
    })

    it('Update re-derives and raises Rows change', () =>
    {
        const vm = Fx.Vm([])
        let raised = 0
        vm.PropertyChanged(TenantsViewModel.RowsProperty).subscribe(() => { raised++ })
        assert.equal(vm.Rows[0].connection, FleetConnection.Awaiting)
        vm.Update([Fx.Tenant('t1', 'a')], [Fx.Client('a')], [Fx.Hive('h1', 't1', Fx.Ago(Fx.HourMs), 2)])
        assert.equal(vm.Rows.length, 1)
        assert.equal(vm.Rows[0].connection, FleetConnection.Connected)
        assert.equal(vm.Rows[0].observedEnvCount, 2)
        assert.equal(raised, 1)
    })
})
