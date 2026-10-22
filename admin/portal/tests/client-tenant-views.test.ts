import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CreateClientViewModel } from '../src/create-client-view-model.js'
import { CreateTenantViewModel } from '../src/create-tenant-view-model.js'
import { TenantListViewModel } from '../src/tenant-list-view-model.js'
import type { ClientDto, TenantDto } from '../src/portal-types.js'

class FakeClient
{
    public Calls: unknown[][] = []

    public async CreateClient(id: string, displayName: string, subscriptionRef?: string): Promise<ClientDto>
    {
        this.Calls.push(['CreateClient', id, displayName, subscriptionRef])
        return { id, displayName, subscriptionRef }
    }

    public async ListClients(): Promise<ClientDto[]>
    {
        return [{ id: 'c1', displayName: 'One' }, { id: 'c2', displayName: 'Two' }]
    }

    public async CreateTenant(id: string, clientId: string, displayName: string): Promise<TenantDto>
    {
        this.Calls.push(['CreateTenant', id, clientId, displayName])
        return { id, clientId, displayName }
    }

    public async ListTenants(clientId?: string): Promise<TenantDto[]>
    {
        this.Calls.push(['ListTenants', clientId])
        return []
    }

    public async DeleteTenant(id: string): Promise<void>
    {
        this.Calls.push(['DeleteTenant', id])
    }
}

describe('client/tenant view-models', () =>
{
    it('create-client VM submits its fields', async () =>
    {
        const fake = new FakeClient()
        const vm = new CreateClientViewModel(fake)
        vm.Id = ' acme '
        vm.DisplayName = 'Acme Corp'
        vm.SubscriptionRef = 'sub-1'
        await vm.Submit()
        assert.deepEqual(fake.Calls, [['CreateClient', 'acme', 'Acme Corp', 'sub-1']])
    })

    it('create-client VM omits a blank subscription ref', async () =>
    {
        const fake = new FakeClient()
        const vm = new CreateClientViewModel(fake)
        vm.Id = 'a'
        vm.DisplayName = 'A'
        await vm.Submit()
        assert.deepEqual(fake.Calls, [['CreateClient', 'a', 'A', undefined]])
    })

    it('create-tenant VM lists clients and submits the chosen clientId', async () =>
    {
        const fake = new FakeClient()
        const vm = new CreateTenantViewModel(fake)
        await vm.Load()
        assert.deepEqual(vm.Clients.map(c => c.id), ['c1', 'c2'])
        vm.ClientId = 'c2'
        vm.Id = 't1'
        vm.DisplayName = 'Tenant One'
        await vm.Submit()
        assert.deepEqual(fake.Calls, [['CreateTenant', 't1', 'c2', 'Tenant One']])
    })

    it('tenant-list VM filters by its client id', async () =>
    {
        const fake = new FakeClient()
        const vm = new TenantListViewModel(fake, 'c1')
        await vm.Load()
        await vm.Delete('t9')
        assert.deepEqual(fake.Calls, [['ListTenants', 'c1'], ['DeleteTenant', 't9']])
    })
})
