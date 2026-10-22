import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CreateHiveViewModel } from '../src/create-hive-view-model.js'
import { HiveListViewModel } from '../src/hive-list-view-model.js'
import type { HiveDto } from '../src/portal-types.js'

class FakeClient
{
    public Calls: unknown[][] = []

    public async CreateHive(input: HiveDto): Promise<HiveDto>
    {
        this.Calls.push(['CreateHive', input])
        return input
    }

    public async ListHives(tenantId?: string): Promise<HiveDto[]>
    {
        this.Calls.push(['ListHives', tenantId])
        return []
    }

    public async DeleteHive(id: string): Promise<void>
    {
        this.Calls.push(['DeleteHive', id])
    }
}

describe('hive view-models', () =>
{
    it('create VM defaults to backend local + mode attach and omits blank refs', async () =>
    {
        const fake = new FakeClient()
        const vm = new CreateHiveViewModel(fake, 't1')
        vm.Id = ' h1 '
        vm.DisplayName = 'Hive One'
        await vm.Submit()
        assert.deepEqual(fake.Calls, [['CreateHive', {
            id: 'h1', tenantId: 't1', displayName: 'Hive One',
            cluster: { backend: 'local', mode: 'attach' },
            registry: { mode: 'attach' },
        }]])
    })

    it('create VM submits cluster/registry/trustRootRef from its fields', async () =>
    {
        const fake = new FakeClient()
        const vm = new CreateHiveViewModel(fake, 't1')
        vm.Id = 'h2'
        vm.DisplayName = 'Hive Two'
        vm.Backend = 'aks'
        vm.ClusterMode = 'provision'
        vm.ConfigRef = 'cfg-ref'
        vm.RegistryMode = 'provision'
        vm.Endpoint = 'reg.example.com'
        vm.CredentialRef = 'cred-ref'
        vm.TrustRootRef = 'trust-ref'
        await vm.Submit()
        const sent = fake.Calls[0][1] as HiveDto
        assert.deepEqual(sent, {
            id: 'h2', tenantId: 't1', displayName: 'Hive Two',
            cluster: { backend: 'aks', mode: 'provision', configRef: 'cfg-ref' },
            registry: { mode: 'provision', endpoint: 'reg.example.com', credentialRef: 'cred-ref' },
            trustRootRef: 'trust-ref',
        })
    })

    it('submitted body carries only reference names, no secret-value key', async () =>
    {
        const fake = new FakeClient()
        const vm = new CreateHiveViewModel(fake, 't1')
        vm.Id = 'h3'
        vm.DisplayName = 'H'
        vm.ConfigRef = 'c'
        vm.CredentialRef = 'k'
        vm.TrustRootRef = 'r'
        await vm.Submit()
        const keys = JSON.stringify(fake.Calls[0][1]).match(/"[A-Za-z]+":/g) ?? []
        const allowed = ['id', 'tenantId', 'displayName', 'cluster', 'backend', 'mode', 'configRef', 'registry', 'endpoint', 'credentialRef', 'trustRootRef']
        for (const k of keys)
        {
            assert.ok(allowed.includes(k.slice(1, -2)), k)
            assert.ok(!/secret|password|token|key$/i.test(k.slice(1, -2)), k)
        }
    })

    it('hive-list VM filters by its tenant id and deletes', async () =>
    {
        const fake = new FakeClient()
        const vm = new HiveListViewModel(fake, 't1')
        await vm.Load()
        await vm.Delete('h1')
        assert.deepEqual(fake.Calls, [['ListHives', 't1'], ['DeleteHive', 'h1']])
    })
})
