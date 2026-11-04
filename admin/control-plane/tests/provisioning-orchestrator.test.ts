import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { HiveBackend, InfraMode, InvalidRecordIdError } from '../platform-records.js'
import type { HiveRecord } from '../platform-records.js'
import { PlatformDirectory, RecordExistsError, RecordKind, TenantClientMismatchError, UnknownClientError, UnknownTenantError } from '../platform-directory.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { ProvisionFailedError, ProvisioningOrchestrator } from '../provisioning-orchestrator.js'
import type { ProvisionInput } from '../provisioning-orchestrator.js'
import { FakeProvisioning } from './fake-provisioning.js'

class FaultyDirectory extends PlatformDirectory
{
    public FailCreateHive = false
    public FailDeleteClient = false
    public FailDeleteTenant = false

    public override async CreateHive(input: Parameters<PlatformDirectory['CreateHive']>[0]): Promise<HiveRecord>
    {
        if (this.FailCreateHive)
        {
            throw new Error(OrchestratorFixture.UnsafeMessage)
        }
        return super.CreateHive(input)
    }

    public override async DeleteTenant(id: string): Promise<void>
    {
        if (this.FailDeleteTenant)
        {
            throw new Error(OrchestratorFixture.UnsafeMessage)
        }
        return super.DeleteTenant(id)
    }

    public override async DeleteClient(id: string): Promise<void>
    {
        if (this.FailDeleteClient)
        {
            throw new Error(OrchestratorFixture.UnsafeMessage)
        }
        return super.DeleteClient(id)
    }
}

class FakeDeployments
{
    public static readonly Token = 'agent-token-abc123'

    public FailRegister = false
    public readonly Registered: string[] = []
    public readonly Deregistered: string[] = []

    public async RegisterHive(id: string): Promise<string>
    {
        if (this.FailRegister)
        {
            throw new Error(OrchestratorFixture.UnsafeMessage)
        }
        this.Registered.push(id)
        return FakeDeployments.Token
    }

    public async DeregisterHive(id: string): Promise<void>
    {
        this.Deregistered.push(id)
    }

    public AsRegistry(): PlatformDeploymentRegistry
    {
        return this as unknown as PlatformDeploymentRegistry
    }
}

class OrchestratorFixture
{
    public static readonly UnsafeMessage = 'leaky-detail-should-not-surface'
    public static readonly Now = '2026-10-29T12:00:00.000Z'

    public directory!: FaultyDirectory
    public provisioning!: FakeProvisioning
    public deployments = new FakeDeployments()
    public orchestrator!: ProvisioningOrchestrator

    public static async Create(): Promise<OrchestratorFixture>
    {
        const f = new OrchestratorFixture()
        const dir = await mkdtemp(join(tmpdir(), 'orch-'))
        f.directory = new FaultyDirectory(
            new ClientRegistry(join(dir, 'clients.json')),
            new TenantRegistry(join(dir, 'tenants.json')),
            new HiveRegistry(join(dir, 'hives.json')),
            { List: () => [] },
            () => new Date(OrchestratorFixture.Now))
        await f.directory.Load()
        f.provisioning = new FakeProvisioning(f.directory)
        f.orchestrator = new ProvisioningOrchestrator(f.directory, f.provisioning.AsService(), f.deployments.AsRegistry())
        return f
    }

    public static Input(): ProvisionInput
    {
        return {
            client: { id: 'c1', displayName: 'Client One' },
            tenant: { id: 't1', displayName: 'Tenant One', ownerEmail: 'owner@example.com' },
            hive: {
                id: 'h1',
                displayName: 'Hive One',
                cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: 'kube-ref' },
                registry: { mode: InfraMode.Attach, endpoint: 'registry.example.com', credentialRef: 'cred-ref' }
            }
        }
    }

    public AssertStoresEmpty(): void
    {
        assert.equal(this.directory.ListClients().length, 0)
        assert.equal(this.directory.ListTenants().length, 0)
        assert.equal(this.directory.ListHives().length, 0)
    }

    public async CaptureFailure(): Promise<ProvisionFailedError>
    {
        try
        {
            await this.orchestrator.Provision(OrchestratorFixture.Input())
        }
        catch (e)
        {
            assert.ok(e instanceof ProvisionFailedError)
            return e
        }
        throw new Error('expected ProvisionFailedError')
    }
}

test('happy path provisions client + tenant + hive and returns both secrets', async () =>
{
    const f = await OrchestratorFixture.Create()
    const result = await f.orchestrator.Provision(OrchestratorFixture.Input())
    assert.equal(result.client.id, 'c1')
    assert.equal(result.tenant.id, 't1')
    assert.equal(result.hive.id, 'h1')
    assert.equal(result.secrets.ownerEmail, 'owner@example.com')
    assert.equal(result.secrets.ownerPassword, FakeProvisioning.Password)
    assert.equal(result.secrets.agentToken, FakeDeployments.Token)
    assert.deepEqual(f.deployments.Registered, ['h1'])
    assert.ok(f.directory.GetClient('c1'))
    assert.ok(f.directory.GetTenant('t1'))
    assert.ok(f.directory.GetHive('h1'))
})

test('an unsafe hive id (=b, "b ") is refused before ANY write', async () =>
{
    for (const id of ['=b', 'b '])
    {
        const f = await OrchestratorFixture.Create()
        const input = OrchestratorFixture.Input()
        input.hive.id = id
        await assert.rejects(() => f.orchestrator.Provision(input), (e: unknown) => e instanceof InvalidRecordIdError && /hive id must be/.test(e.message))
        f.AssertStoresEmpty()
        assert.equal(f.provisioning.Calls.length, 0)
        assert.equal(f.deployments.Registered.length, 0)
    }
})

test('duplicate client id -> RecordExistsError and ZERO writes', async () =>
{
    const f = await OrchestratorFixture.Create()
    await f.directory.CreateClient({ id: 'c1', displayName: 'Existing' })
    await assert.rejects(() => f.orchestrator.Provision(OrchestratorFixture.Input()), RecordExistsError)
    assert.equal(f.directory.ListClients().length, 1)
    assert.equal(f.directory.ListClients()[0].displayName, 'Existing')
    assert.equal(f.directory.ListTenants().length, 0)
    assert.equal(f.directory.ListHives().length, 0)
    assert.equal(f.provisioning.Calls.length, 0)
    assert.equal(f.deployments.Registered.length, 0)
})

test('a duplicate id names the record kind and id', async () =>
{
    const f = await OrchestratorFixture.Create()
    await f.directory.CreateClient({ id: 'c1', displayName: 'Existing' })
    await assert.rejects(() => f.orchestrator.Provision(OrchestratorFixture.Input()), (e: unknown) =>
        e instanceof RecordExistsError && e.kind === RecordKind.Client && e.message === 'Client "c1" already exists')
})

test('an existing client is used as is: tenant + hive created, the client untouched', async () =>
{
    const f = await OrchestratorFixture.Create()
    await f.directory.CreateClient({ id: 'c1', displayName: 'Existing' })
    const input = OrchestratorFixture.Input()
    input.client = { existing: true, id: 'c1' }
    const result = await f.orchestrator.Provision(input)
    assert.equal(result.client.displayName, 'Existing')
    assert.equal(result.tenant.clientId, 'c1')
    assert.equal(result.secrets.ownerPassword, FakeProvisioning.Password)
    assert.equal(f.directory.ListClients().length, 1)
    assert.ok(f.directory.GetHive('h1'))
})

test('an existing tenant is used as is: only the hive is created, no Owner secrets', async () =>
{
    const f = await OrchestratorFixture.Create()
    await f.directory.CreateClient({ id: 'c1', displayName: 'Existing' })
    await f.directory.CreateTenant({ id: 't1', clientId: 'c1', displayName: 'Existing T' })
    const input = OrchestratorFixture.Input()
    input.client = { existing: true, id: 'c1' }
    input.tenant = { existing: true, id: 't1' }
    const result = await f.orchestrator.Provision(input)
    assert.equal(result.tenant.displayName, 'Existing T')
    assert.equal(result.hive.tenantId, 't1')
    assert.equal(result.secrets.ownerPassword, undefined)
    assert.equal(result.secrets.ownerEmail, undefined)
    assert.equal(result.secrets.agentToken, FakeDeployments.Token)
    assert.equal(f.provisioning.Calls.length, 0)
})

test('a failure after an existing client + tenant never rolls them back', async () =>
{
    const f = await OrchestratorFixture.Create()
    await f.directory.CreateClient({ id: 'c1', displayName: 'Existing' })
    await f.directory.CreateTenant({ id: 't1', clientId: 'c1', displayName: 'Existing T' })
    f.directory.FailCreateHive = true
    const input = OrchestratorFixture.Input()
    input.client = { existing: true, id: 'c1' }
    input.tenant = { existing: true, id: 't1' }
    await assert.rejects(() => f.orchestrator.Provision(input), (e: unknown) =>
        e instanceof ProvisionFailedError && e.rollback.rolledBack.length === 0 && e.rollback.residue.length === 0)
    assert.ok(f.directory.GetClient('c1'))
    assert.ok(f.directory.GetTenant('t1'))
})

test('an unknown existing client or tenant is refused with zero writes', async () =>
{
    const f = await OrchestratorFixture.Create()
    const input = OrchestratorFixture.Input()
    input.client = { existing: true, id: 'c1' }
    await assert.rejects(() => f.orchestrator.Provision(input), UnknownClientError)
    await f.directory.CreateClient({ id: 'c1', displayName: 'Existing' })
    input.tenant = { existing: true, id: 't1' }
    await assert.rejects(() => f.orchestrator.Provision(input), UnknownTenantError)
    assert.equal(f.directory.ListTenants().length, 0)
    assert.equal(f.directory.ListHives().length, 0)
})

test('an existing tenant of another client is refused with zero writes', async () =>
{
    const f = await OrchestratorFixture.Create()
    await f.directory.CreateClient({ id: 'c1', displayName: 'One' })
    await f.directory.CreateClient({ id: 'c2', displayName: 'Two' })
    await f.directory.CreateTenant({ id: 't1', clientId: 'c2', displayName: 'T' })
    const input = OrchestratorFixture.Input()
    input.client = { existing: true, id: 'c1' }
    input.tenant = { existing: true, id: 't1' }
    await assert.rejects(() => f.orchestrator.Provision(input), TenantClientMismatchError)
    assert.equal(f.directory.ListHives().length, 0)
    assert.equal(f.deployments.Registered.length, 0)
})

test('duplicate tenant id -> RecordExistsError and ZERO writes', async () =>
{
    const f = await OrchestratorFixture.Create()
    await f.directory.CreateClient({ id: 'other', displayName: 'Other' })
    await f.directory.CreateTenant({ id: 't1', clientId: 'other', displayName: 'Existing' })
    await assert.rejects(() => f.orchestrator.Provision(OrchestratorFixture.Input()), RecordExistsError)
    assert.equal(f.directory.ListClients().length, 1)
    assert.equal(f.directory.ListTenants().length, 1)
    assert.equal(f.directory.ListHives().length, 0)
    assert.equal(f.provisioning.Calls.length, 0)
    assert.equal(f.deployments.Registered.length, 0)
})

test('duplicate hive id -> RecordExistsError and ZERO writes', async () =>
{
    const f = await OrchestratorFixture.Create()
    const seed = OrchestratorFixture.Input()
    await f.directory.CreateClient({ id: 'other', displayName: 'Other' })
    await f.directory.CreateTenant({ id: 'otherT', clientId: 'other', displayName: 'OT' })
    await f.directory.CreateHive({ id: 'h1', tenantId: 'otherT', displayName: 'Existing', cluster: seed.hive.cluster, registry: seed.hive.registry })
    await assert.rejects(() => f.orchestrator.Provision(OrchestratorFixture.Input()), RecordExistsError)
    assert.equal(f.directory.ListClients().length, 1)
    assert.equal(f.directory.ListTenants().length, 1)
    assert.equal(f.directory.ListHives().length, 1)
    assert.equal(f.provisioning.Calls.length, 0)
    assert.equal(f.deployments.Registered.length, 0)
})

test('CreateHive failure rolls back tenant + client and reports residue', async () =>
{
    const f = await OrchestratorFixture.Create()
    f.directory.FailCreateHive = true
    const err = await f.CaptureFailure()
    assert.ok(err.rollback.rolledBack.includes('client:c1'))
    assert.ok(err.rollback.rolledBack.includes('tenant:t1'))
    assert.ok(err.rollback.residue.includes('idp-realm:t1'))
    f.AssertStoresEmpty()
})

test('rolling back a provisioned tenant also forgets its discovery-index accounts', async () =>
{
    const f = await OrchestratorFixture.Create()
    f.directory.FailCreateHive = true
    await f.CaptureFailure()
    assert.deepEqual(f.provisioning.Forgotten, ['t1'])
})

test('RegisterHive failure rolls back hive + tenant + client', async () =>
{
    const f = await OrchestratorFixture.Create()
    f.deployments.FailRegister = true
    const err = await f.CaptureFailure()
    assert.ok(err.rollback.rolledBack.includes('hive:h1'))
    assert.ok(err.rollback.rolledBack.includes('tenant:t1'))
    assert.ok(err.rollback.rolledBack.includes('client:c1'))
    assert.ok(err.rollback.residue.includes('idp-realm:t1'))
    f.AssertStoresEmpty()
})

test('a failing compensating delete is reported in residue', async () =>
{
    const f = await OrchestratorFixture.Create()
    f.directory.FailCreateHive = true
    f.directory.FailDeleteClient = true
    const err = await f.CaptureFailure()
    assert.ok(err.rollback.residue.includes('client:c1'))
    assert.ok(!err.rollback.rolledBack.includes('client:c1'))
    assert.ok(err.rollback.rolledBack.includes('tenant:t1'))
})

test('ProvisionFailedError carries no secret', async () =>
{
    const f = await OrchestratorFixture.Create()
    f.deployments.FailRegister = true
    const err = await f.CaptureFailure()
    const blob = err.message + JSON.stringify(err.rollback)
    assert.ok(!blob.includes(FakeProvisioning.Password))
    assert.ok(!blob.includes(FakeDeployments.Token))
    assert.ok(!blob.includes(OrchestratorFixture.UnsafeMessage))
})

test('tenant provision failure rolls back the client and reports idp-realm residue', async () =>
{
    const f = await OrchestratorFixture.Create()
    f.provisioning.FailWith = new Error(OrchestratorFixture.UnsafeMessage)
    const err = await f.CaptureFailure()
    assert.ok(err.rollback.rolledBack.includes('client:c1'))
    assert.ok(err.rollback.residue.includes('idp-realm:t1'))
    f.AssertStoresEmpty()
})

test('a failing DeleteTenant during rollback is reported in residue (with idp-realm)', async () =>
{
    const f = await OrchestratorFixture.Create()
    f.directory.FailCreateHive = true
    f.directory.FailDeleteTenant = true
    const err = await f.CaptureFailure()
    assert.ok(err.rollback.residue.includes('tenant:t1'))
    assert.ok(err.rollback.residue.includes('idp-realm:t1'))
    assert.ok(!err.rollback.rolledBack.includes('tenant:t1'))
})
