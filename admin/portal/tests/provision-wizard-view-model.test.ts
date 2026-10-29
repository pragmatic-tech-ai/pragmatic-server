import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProvisionWizardViewModel, WizardStep } from '../src/provision-wizard-view-model.js'
import type { ProvisionInputDto, ProvisionResultDto } from '../src/portal-types.js'

const OwnerPassword = 'S3cret-owner-pw-9f2a'
const AgentToken = 'tok-agent-77c1d0'

class FakeSink
{
    public Inputs: ProvisionInputDto[] = []

    public async Provision(input: ProvisionInputDto): Promise<ProvisionResultDto>
    {
        this.Inputs.push(input)
        return {
            client: { id: input.client.id, displayName: input.client.displayName },
            tenant: { id: input.tenant.id, displayName: input.tenant.displayName },
            hive: { id: input.hive.id, displayName: input.hive.displayName, cluster: input.hive.cluster, registry: input.hive.registry },
            secrets: { ownerEmail: input.tenant.ownerEmail, ownerPassword: OwnerPassword, agentToken: AgentToken }
        } as unknown as ProvisionResultDto
    }
}

class Fixture
{
    public static Fill(vm: ProvisionWizardViewModel): void
    {
        vm.ClientId = ' c1 '
        vm.ClientDisplayName = 'Client One'
        vm.TenantId = 't1'
        vm.TenantDisplayName = 'Tenant One'
        vm.OwnerEmail = 'o@x.io'
        vm.HiveId = 'h1'
        vm.HiveDisplayName = 'Hive One'
    }
}

describe('ProvisionWizardViewModel', () =>
{
    it('steps are invalid until required fields are set', () =>
    {
        const vm = new ProvisionWizardViewModel(new FakeSink())
        assert.equal(vm.StepValid(WizardStep.Client), false)
        vm.ClientId = 'c'
        assert.equal(vm.StepValid(WizardStep.Client), false)
        vm.ClientDisplayName = 'C'
        assert.equal(vm.StepValid(WizardStep.Client), true)
        assert.equal(vm.StepValid(WizardStep.Tenant), false)
        vm.TenantId = 't'
        vm.TenantDisplayName = 'T'
        assert.equal(vm.StepValid(WizardStep.Tenant), false)
        vm.OwnerEmail = '  '
        assert.equal(vm.StepValid(WizardStep.Tenant), false)
        vm.OwnerEmail = 'a@b.c'
        assert.equal(vm.StepValid(WizardStep.Tenant), true)
        assert.equal(vm.CanProvision(), false)
        vm.HiveId = 'h'
        assert.equal(vm.StepValid(WizardStep.Hive), false)
        vm.HiveDisplayName = 'H'
        assert.equal(vm.StepValid(WizardStep.Hive), true)
        assert.equal(vm.CanProvision(), true)
    })

    it('Provision composes the input, calls the sink once, returns the result', async () =>
    {
        const sink = new FakeSink()
        const vm = new ProvisionWizardViewModel(sink)
        Fixture.Fill(vm)
        const result = await vm.Provision()
        assert.equal(sink.Inputs.length, 1)
        const input = sink.Inputs[0]
        assert.equal(input.client.id, 'c1')
        assert.equal('subscriptionRef' in input.client, false)
        assert.equal('clientId' in input.tenant, false)
        assert.equal('tenantId' in input.hive, false)
        assert.equal('trustRootRef' in input.hive, false)
        assert.deepEqual(input.hive.cluster, { backend: 'local', mode: 'attach' })
        assert.deepEqual(input.hive.registry, { mode: 'attach' })
        assert.equal(result.secrets.ownerPassword, OwnerPassword)
        assert.equal(result.secrets.agentToken, AgentToken)

        vm.SubscriptionRef = ' sub-1 '
        vm.Endpoint = 'reg.io'
        await vm.Provision()
        assert.equal(sink.Inputs[1].client.subscriptionRef, 'sub-1')
        assert.equal(sink.Inputs[1].hive.registry.endpoint, 'reg.io')
    })

    it('does not retain secrets', async () =>
    {
        const vm = new ProvisionWizardViewModel(new FakeSink())
        Fixture.Fill(vm)
        await vm.Provision()
        const dump = JSON.stringify(vm, (_k, v) => (typeof v === 'function' ? undefined : v))
        assert.equal(dump.includes(OwnerPassword), false)
        assert.equal(dump.includes(AgentToken), false)
        const own = vm as unknown as Record<string, unknown>
        for (const key of Object.getOwnPropertyNames(vm))
        {
            const value = String(JSON.stringify(own[key]) ?? '')
            assert.equal(value.includes(OwnerPassword), false, key)
            assert.equal(value.includes(AgentToken), false, key)
        }
    })
})
