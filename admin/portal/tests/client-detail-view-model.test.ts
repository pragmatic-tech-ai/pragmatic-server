import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ClientDetailViewModel } from '../src/client-detail-view-model.js'
import { FleetConnection } from '../src/fleet-view-model.js'
import type { ClientDto, FleetHiveDto, TenantDto } from '../src/portal-types.js'

class Fx
{
    public static readonly Now = new Date('2026-10-28T12:00:00.000Z')

    public static Client(subscriptionRef?: string, createdAt = '2026-01-02T03:04:05.000Z'): ClientDto
    {
        return { id: 'c1', displayName: 'Acme', subscriptionRef, createdAt } as ClientDto
    }

    public static Tenant(id: string): TenantDto
    {
        return { id, clientId: 'c1', displayName: 'Tenant ' + id } as TenantDto
    }

    public static Hive(id: string, tenantId: string): FleetHiveDto
    {
        return {
            id,
            displayName: 'Hive ' + id,
            tenant: { id: tenantId, displayName: 'Tenant ' + tenantId },
            client: { id: 'c1', displayName: 'Acme' },
            clusterBackend: 'k8s',
            clusterMode: 'managed',
            lastSeen: new Date(Fx.Now.getTime() - 1000).toISOString(),
            environments: [{ name: 'e0', ready: true, detail: '' }, { name: 'e1', ready: true, detail: '' }],
        } as FleetHiveDto
    }

    public static Vm(client: ClientDto, tenants: TenantDto[], fleet: FleetHiveDto[]): ClientDetailViewModel
    {
        return new ClientDetailViewModel(client, tenants, fleet, () => Fx.Now)
    }
}

describe('ClientDetailViewModel', () =>
{
    it('derives a row per tenant, with Awaiting for a tenant without a hive', () =>
    {
        const vm = Fx.Vm(Fx.Client(), [Fx.Tenant('t1'), Fx.Tenant('t2')], [Fx.Hive('h1', 't1')])
        assert.equal(vm.Rows.length, 2)
        assert.equal(vm.Rows[0].connection, FleetConnection.Connected)
        assert.equal(vm.Rows[0].hiveName, 'Hive h1')
        assert.equal(vm.Rows[0].observedEnvCount, 2)
        assert.equal(vm.Rows[1].connection, FleetConnection.Awaiting)
        assert.equal(vm.Rows[1].hiveName, 'No hive yet')
        assert.equal(vm.Rows[1].lastSeenLabel, 'Awaiting first dial-in')
        assert.equal(vm.Rows[1].observedEnvCount, 0)
    })

    it('Profile has four keys in order and falls back to (none)', () =>
    {
        const vm = Fx.Vm(Fx.Client(undefined), [], [])
        assert.deepEqual(vm.Profile.map(p => p.key), ['Client id', 'Display name', 'Subscription ref', 'Client since'])
        assert.equal(vm.Profile[2].value, '(none)')
        assert.equal(vm.Profile[3].value, '2026-01-02')
    })

    it('Client since is Unknown for empty or invalid dates', () =>
    {
        assert.equal(Fx.Vm(Fx.Client('s', ''), [], []).Profile[3].value, 'Unknown')
        assert.equal(Fx.Vm(Fx.Client('s', 'not-a-date'), [], []).Profile[3].value, 'Unknown')
    })

    it('zero tenants yields empty Rows', () =>
    {
        assert.equal(Fx.Vm(Fx.Client(), [], [Fx.Hive('h1', 't1')]).Rows.length, 0)
    })
})
