import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord } from '../platform-records.js'
import { PlatformDirectory, RecordExistsError } from '../platform-directory.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { ProvisionFailedError, ProvisioningOrchestrator } from '../provisioning-orchestrator.js'
import type { ProvisionInput } from '../provisioning-orchestrator.js'
import { FakeProvisioning } from './fake-provisioning.js'

class FaultyDirectory extends PlatformDirectory
{
    public FailCreateHive = false
    public FailDeleteClient = false

    public override async CreateHive(input: Parameters<PlatformDirectory['CreateHive']>[0]): Promise<HiveRecord>
    {
        if (this.FailCreateHive)
        {
            throw new Error(OrchestratorFixture.UnsafeMessage)
        }
        return super.CreateHive(input)
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
