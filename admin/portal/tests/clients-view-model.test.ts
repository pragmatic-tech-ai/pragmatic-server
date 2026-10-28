import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ClientsViewModel } from '../src/clients-view-model.js'
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
        return { id, clientId, displayName: 'Tenant ' + id }
    }

    public static Hive(id: string, clientId: string | null, lastSeen: string | null): FleetHiveDto
    {
        return {
            id,
            displayName: id,
            tenant: null,
            client: clientId === null ? null : { id: clientId, displayName: 'Client ' + clientId },
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen,
            environments: [],
        } as FleetHiveDto
    }

    public static Vm(fleet: FleetHiveDto[]): ClientsViewModel
    {
        return new ClientsViewModel(
            [Fx.Client('a'), Fx.Client('b'), Fx.Client('c')],
            [Fx.Tenant('t1', 'a'), Fx.Tenant('t2', 'a'), Fx.Tenant('t3', 'b')],
            fleet,
            () => Fx.Now,
        )
    }
}

describe('ClientsViewModel', () =>
{
    it('rolls up tenants, hives and connection summary per client', () =>
    {
        const vm = Fx.Vm([
            Fx.Hive('h1', 'a', Fx.Ago(Fx.HourMs)),
            Fx.Hive('h2', 'a', Fx.Ago(24 * Fx.HourMs)),
            Fx.Hive('h3', 'b', null),
            Fx.Hive('h4', null, Fx.Ago(Fx.HourMs)),
        ])
        assert.equal(vm.Rows.length, 3)
        const a = vm.Rows[0]
        assert.equal(a.tenantCount, 2)
        assert.equal(a.hiveCount, 2)
        assert.equal(a.connectionSummary, '1 connected, 1 quiet')
        const b = vm.Rows[1]
        assert.equal(b.tenantCount, 1)
        assert.equal(b.connectionSummary, '1 awaiting')
    })

    it('client with no hives says No hives', () =>
    {
        const c = Fx.Vm([Fx.Hive('h1', 'a', null)]).Rows[2]
        assert.equal(c.hiveCount, 0)
        assert.equal(c.tenantCount, 0)
        assert.equal(c.connectionSummary, 'No hives')
    })

    it('Update re-derives and raises Rows change', () =>
    {
        const vm = Fx.Vm([])
        let raised = 0
        vm.PropertyChanged(ClientsViewModel.RowsProperty).subscribe(() => { raised++ })
        assert.equal(vm.Rows[0].connectionSummary, 'No hives')
        vm.Update([Fx.Client('a')], [], [Fx.Hive('h1', 'a', Fx.Ago(Fx.HourMs))])
        assert.equal(vm.Rows.length, 1)
        assert.equal(vm.Rows[0].connectionSummary, '1 connected')
        assert.equal(raised, 1)
    })
})
