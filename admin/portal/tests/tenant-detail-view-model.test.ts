import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TenantDetailViewModel } from '../src/tenant-detail-view-model.js'
import { FleetConnection } from '../src/fleet-view-model.js'
import type { ClientDto, FleetHiveDto, TenantDto } from '../src/portal-types.js'

class Fx
{
    public static readonly Now = new Date('2026-10-28T12:00:00.000Z')

    public static Client(): ClientDto
    {
        return { id: 'c1', displayName: 'Acme', createdAt: '2026-01-02T03:04:05.000Z' } as ClientDto
    }

    public static Tenant(clientId = 'c1'): TenantDto
    {
        return { id: 't1', clientId, displayName: 'Tenant t1' } as TenantDto
    }

    public static Hive(): FleetHiveDto
    {
        return {
            id: 'h1',
            displayName: 'Hive h1',
            tenant: { id: 't1', displayName: 'Tenant t1' },
            client: { id: 'c1', displayName: 'Acme' },
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen: new Date(Fx.Now.getTime() - 1000).toISOString(),
            environments: [
                { name: 'prod', ready: true, image: 'img:1', detail: 'ok' },
                { name: 'dev', ready: false, detail: 'pending' },
            ],
        } as FleetHiveDto
    }

    public static Vm(tenant: TenantDto, fleet: FleetHiveDto[]): TenantDetailViewModel
    {
        return new TenantDetailViewModel(tenant, [Fx.Client()], fleet, () => Fx.Now)
    }
}

describe('TenantDetailViewModel', () =>
{
    it('derives env rows and binding from the tenant hive', () =>
    {
        const vm = Fx.Vm(Fx.Tenant(), [Fx.Hive()])
        assert.equal(vm.EnvRows.length, 2)
        assert.equal(vm.EnvRows[0].image, 'img:1')
        assert.equal(vm.EnvRows[1].ready, false)
        assert.equal(vm.EnvRows[1].image, '-')
        assert.equal(vm.Binding.hasHive, true)
        assert.equal(vm.Binding.hiveName, 'Hive h1')
        assert.equal(vm.Binding.cluster, 'k8s / managed')
        assert.equal(vm.Binding.connection, FleetConnection.Connected)
        assert.ok(vm.Binding.lastSeenLabel.length > 0)
        assert.equal(vm.ClientName, 'Acme')
    })

    it('reports no hive when none is bound', () =>
    {
        const vm = Fx.Vm(Fx.Tenant(), [])
        assert.equal(vm.Binding.hasHive, false)
        assert.equal(vm.Binding.hiveName, 'No hive yet')
        assert.equal(vm.Binding.connection, FleetConnection.Awaiting)
        assert.equal(vm.Binding.lastSeenLabel, 'Awaiting first dial-in')
        assert.equal(vm.EnvRows.length, 0)
    })

    it('falls back for an unknown client', () =>
    {
        const vm = Fx.Vm(Fx.Tenant('missing'), [])
        assert.equal(vm.ClientName, '(unknown client)')
    })
})
