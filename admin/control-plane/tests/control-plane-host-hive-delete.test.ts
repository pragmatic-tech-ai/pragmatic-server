import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { RolloutFixture } from './rollout-fixture.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSession, type OperatorSummary } from '../operator-identity.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { KindHiveOrchestrator } from '../kind-hive-orchestrator.js'
import type { IKind } from '../kind.js'
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import { AgentUninstallError, HiveAgentUninstaller, HiveClusterDestroyError } from '../hive-agent-uninstaller.js'
import { KindError } from '../kind.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { HiveBootstrapBundle } from '../hive-bootstrap-bundle.js'
import { KubectlError, type IKubectl } from '../kubectl.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { AuditRegistry } from '../audit-record.js'
import { HiveNotRegisteredError } from '../rollout-errors.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'

type Reply = { status: number; body: string }
type DeleteBody = { ok?: boolean; retained?: string[]; notice?: string; error?: string; code?: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly Token = 'full-token'

    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null> { return null }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        return token === FakeOperator.Token ? { email: 'op@example.com', principalId: 'p1', role: OperatorRole.Full } : null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]> { return [] }
    public async SetOperatorRole(_e: string, _r: OperatorRole, _a: string): Promise<void> { }
    public async ChangeOwnPassword(_p: string, _c: string, _n: string): Promise<null> { return null }
    public async ResetOperatorPassword(_e: string): Promise<string> { return '' }
    public async SetOperatorDisabled(_e: string, _d: boolean, _a: string): Promise<void> { }
    public async RevokeOperatorSessions(_e: string): Promise<void> { }
    public async CreateOperator(_e: string, _p: string, _r: OperatorRole): Promise<void> { }
    public async Revoke(_t: string): Promise<void> { }
}

// Records the uninstall's kubectl calls into the shared event log.
class FakeKubectl implements IKubectl
{
    public readonly Calls: string[][] = []
    public DeleteError: Error | undefined

    // What exists in the cluster: resource ('kind/name') -> its JSON.
    public readonly Objects = new Map<string, string>()

    public constructor(private readonly events: string[])
    {
    }

    public async Find(_namespace: string, resource: string): Promise<string | undefined>
    {
        return this.Objects.get(resource)
    }

    public async DeleteManifest(manifestJson: string): Promise<void>
    {
        this.events.push('DeleteManifest')
        this.Calls.push(['DeleteManifest', manifestJson])
        if (this.DeleteError !== undefined)
        {
            throw this.DeleteError
        }
    }

    public async DeleteBySelector(namespace: string, resource: string, selector: string): Promise<void>
    {
        this.events.push('DeleteBySelector')
        this.Calls.push(['DeleteBySelector', namespace, resource, selector])
    }

    public async DeleteNamespacesBySelector(selector: string, namePrefix: string): Promise<string[]>
    {
        this.events.push('DeleteNamespacesBySelector')
        this.Calls.push(['DeleteNamespacesBySelector', selector, namePrefix])
        return []
    }

    public async Apply(_m: string): Promise<void> { this.Calls.push(['Apply']) }
    public async ApplyServerSide(_m: string): Promise<void> { this.Calls.push(['ApplyServerSide']) }
    public async RolloutStatus(_n: string, _d: string): Promise<void> { }
    public async SetImage(_n: string, _d: string, _c: string, _i: string): Promise<void> { }
    public async Scale(_n: string, _d: string, _r: number): Promise<void> { }
    public async ScaleStatefulSet(_n: string, _s: string, _r: number): Promise<void> { }
    public async RolloutRestart(_n: string, _d: string): Promise<void> { }
    public async RolloutRestartSelector(_n: string, _s: string): Promise<void> { }
    public async Get(_n: string, _r: string): Promise<string> { return '{}' }
    public async DeleteNamespace(n: string): Promise<void> { this.Calls.push(['DeleteNamespace', n]) }
}

class FakeOrchestrator implements IHiveOrchestrator
{
    public constructor(public readonly Kubectl: FakeKubectl)
    {
    }

    public async PrepareAgent(_image: string): Promise<void> { }
    public async Apply(_w: EnvironmentWorkload): Promise<void> { }
    public async WaitHealthy(_w: EnvironmentWorkload): Promise<void> { }
    public async Health(_w: EnvironmentWorkload): Promise<WorkloadHealth> { return { ready: true, runningImage: undefined, detail: '' } }
    public async Roll(_w: EnvironmentWorkload, _image: string): Promise<void> { }
    public async Scale(_w: EnvironmentWorkload, _replicas: number): Promise<void> { }
    public async ScaleDatabase(_w: EnvironmentWorkload, _replicas: number): Promise<void> { }
    public async Teardown(_w: EnvironmentWorkload): Promise<void> { }
}

class FakeOrchestrators
{
    public readonly Kubectl: FakeKubectl

    public constructor(events: string[])
    {
        this.Kubectl = new FakeKubectl(events)
    }

    public For(_hive: HiveRecord): IHiveOrchestrator
    {
        return new FakeOrchestrator(this.Kubectl)
    }
}

// The deployments' factory: kind hives whose cluster delete is recorded.
class RecordingKindFactory extends HiveOrchestratorFactory
{
    public readonly Destroyed: string[] = []
    public FailWith: Error | undefined

    public override For(hive: HiveRecord): IHiveOrchestrator
    {
        const kind = {
            DeleteCluster: async (name: string) =>
            {
                if (this.FailWith !== undefined)
                {
                    throw this.FailWith
                }
                this.Destroyed.push(name)
            },
        } as unknown as IKind
        return new KindHiveOrchestrator(kind, 'hive-' + hive.id, undefined as unknown as IHiveOrchestrator)
    }
}

class Harness
{
    public static Send(host: ControlPlaneHost, method: string, path: string): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json', cookie: 'cp_session=' + FakeOperator.Token }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end()
        })
    }
}

describe('ControlPlaneHost hive delete uninstalls the agent', () =>
{
    let host: ControlPlaneHost
    let parent: string
    let root: string
    let directory: PlatformDirectory
    let deployments: PlatformDeploymentRegistry
    let audit: AuditRegistry
    let events: string[]
    let orchestrators: FakeOrchestrators
    let kindFactory: RecordingKindFactory
    let tokens: Map<string, string>

    const Make = (uninstaller: HiveAgentUninstaller | undefined): ControlPlaneHost =>
        new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, deployments,
            new FakeProvisioning(directory).AsService(), RolloutFixture.Observations(parent), undefined, false, undefined, undefined, undefined, [], undefined,
            audit, undefined, undefined, 'http://host.docker.internal:7001', undefined, uninstaller)

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-hive-delete-'))
        root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'acme', displayName: 'Acme' })
        const hives: Array<[string, HiveBackend, InfraMode]> = [
            ['local1', HiveBackend.Local, InfraMode.Attach], ['kind1', HiveBackend.Local, InfraMode.Provision], ['aks1', HiveBackend.Aks, InfraMode.Attach],
        ]
        events = []
        kindFactory = new RecordingKindFactory()
        deployments = await RolloutFixture.Create(parent, directory, kindFactory)
        tokens = new Map()
        for (const [id, backend, mode] of hives)
        {
            await directory.CreateTenant({ id: 't-' + id, clientId: 'acme', displayName: 'T ' + id })
            await directory.CreateHive({ id, tenantId: 't-' + id, displayName: id, cluster: { backend, mode }, registry: { mode: InfraMode.Provision } })
            tokens.set(id, await deployments.RegisterHive(id))
        }
        // Record the delete's platform steps alongside the uninstall's kubectl calls.
        const destroy = deployments.DestroyHiveCluster.bind(deployments)
        deployments.DestroyHiveCluster = async (id: string) => { events.push('DestroyHiveCluster'); await destroy(id) }
        const deregister = deployments.DeregisterHive.bind(deployments)
        deployments.DeregisterHive = async (id: string) => { events.push('DeregisterHive'); await deregister(id) }
        const remove = directory.DeleteHive.bind(directory)
        directory.DeleteHive = async (id: string) => { events.push('DeleteHive'); await remove(id) }
        audit = new AuditRegistry(join(parent, 'audit.json'))
        await audit.Load()
        orchestrators = new FakeOrchestrators(events)
        host = Make(new HiveAgentUninstaller(orchestrators))
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('an attached Local hive: uninstall (names + selector) -> destroy -> deregister -> delete record; the old token is dead', async () =>
    {
        const r = await Harness.Send(host, 'DELETE', '/api/hives/local1')
        assert.equal(r.status, 200)
        assert.deepEqual(events, ['DeleteManifest', 'DeleteManifest', 'DeleteBySelector', 'DeleteNamespacesBySelector', 'DestroyHiveCluster', 'DeregisterHive', 'DeleteHive'])
        assert.deepEqual(orchestrators.Kubectl.Calls, [
            ['DeleteManifest', HiveBootstrapBundle.RemovalManifest('local1')],
            ['DeleteManifest', new K8sManifestBuilder().TenantConsoleRemovalManifest('t-local1', 'local1')],
            ['DeleteBySelector', 'pragmatic-system', 'deployment,service,serviceaccount,secret', 'pragmatic/hive=local1'],
            ['DeleteNamespacesBySelector', 'pragmatic/hive=local1', 'pragmatic-env-'],
        ])
        assert.equal(directory.GetHive('local1'), undefined)
        await assert.rejects(deployments.VerifyAgentToken('local1', tokens.get('local1')!), HiveNotRegisteredError)
    })

    it('the response and the audit entry name what is retained: the tenant-admin data PVC and its seed Secret', async () =>
    {
        const retained = [K8sManifestBuilder.TenantAdminClaimNameOf('t-local1'), K8sManifestBuilder.TenantAdminSeedSecretNameOf('t-local1')]
        orchestrators.Kubectl.Objects.set('persistentvolumeclaim/' + retained[0], '{}')
        orchestrators.Kubectl.Objects.set('secret/' + retained[1], '{}')
        const r = await Harness.Send(host, 'DELETE', '/api/hives/local1')
        assert.deepEqual((JSON.parse(r.body) as DeleteBody).retained, retained)
        const entry = audit.Recent(10).find(e => e.method === 'DELETE')
        assert.equal(entry?.path, '/api/hives/local1')
        assert.equal(entry?.note, 'retained: ' + retained.join(', '))
    })

    it('an uninstall failure: 409 with the code and guidance, record and registration intact, later steps never run', async () =>
    {
        orchestrators.Kubectl.DeleteError = new KubectlError('Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused')
        const r = await Harness.Send(host, 'DELETE', '/api/hives/local1')
        assert.equal(r.status, 409)
        const body = JSON.parse(r.body) as { error: string; code?: string }
        assert.equal(body.code, AgentUninstallError.Code)
        assert.match(body.error, /^Could not remove the hive's agent from its cluster: kubectl failed: Unable to connect/)
        assert.match(body.error, /delete anyway to remove only the platform record/)
        assert.deepEqual(events, ['DeleteManifest'])
        assert.ok(directory.GetHive('local1') !== undefined)
        await deployments.VerifyAgentToken('local1', tokens.get('local1')!)
    })

    it('a retry after the cluster is fixed succeeds (the half-removed agent deletes cleanly)', async () =>
    {
        orchestrators.Kubectl.DeleteError = new KubectlError('connection refused')
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/local1')).status, 409)
        orchestrators.Kubectl.DeleteError = undefined
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/local1')).status, 200)
        assert.equal(directory.GetHive('local1'), undefined)
    })

    it('delete anyway (?force=true) skips the cluster work but still deregisters the token and deletes the record, and is audited as such', async () =>
    {
        orchestrators.Kubectl.DeleteError = new KubectlError('connection refused')
        const r = await Harness.Send(host, 'DELETE', '/api/hives/local1?force=true')
        assert.equal(r.status, 200)
        assert.deepEqual(events, ['DeregisterHive', 'DeleteHive'])
        assert.deepEqual(orchestrators.Kubectl.Calls, [])
        assert.equal(directory.GetHive('local1'), undefined)
        await assert.rejects(deployments.VerifyAgentToken('local1', tokens.get('local1')!), HiveNotRegisteredError)
        const body = JSON.parse(r.body) as DeleteBody
        assert.deepEqual(body.retained, [])
        assert.match(body.notice ?? '', /agent may remain in the cluster/)
        const entry = audit.Recent(10).find(e => e.method === 'DELETE')
        assert.equal(entry?.path, '/api/hives/local1?force=true')
        assert.equal(entry?.status, 200)
    })

    it('a provisioned (kind) hive skips the uninstall: destroying its cluster removes the agent; still deregistered', async () =>
    {
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/kind1')).status, 200)
        assert.deepEqual(events, ['DestroyHiveCluster', 'DeregisterHive', 'DeleteHive'])
        assert.deepEqual(kindFactory.Destroyed, ['hive-kind1'])
        assert.deepEqual(orchestrators.Kubectl.Calls, [])
        await assert.rejects(deployments.VerifyAgentToken('kind1', tokens.get('kind1')!), HiveNotRegisteredError)
    })

    it('a kind cluster that cannot be destroyed: 409 with the code and redacted reason, record and token intact', async () =>
    {
        kindFactory.FailWith = new KindError('Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine. Is the docker daemon running?')
        const r = await Harness.Send(host, 'DELETE', '/api/hives/kind1')
        assert.equal(r.status, 409)
        const body = JSON.parse(r.body) as DeleteBody
        assert.equal(body.code, HiveClusterDestroyError.Code)
        assert.match(body.error ?? '', /^Could not destroy the hive's kind cluster: kind failed: Cannot connect to the Docker daemon/)
        assert.match(body.error ?? '', /delete anyway/)
        assert.ok(directory.GetHive('kind1') !== undefined)
        await deployments.VerifyAgentToken('kind1', tokens.get('kind1')!)
        assert.deepEqual(events, ['DestroyHiveCluster'])
    })

    it('delete anyway on a kind hive skips the cluster destroy, still revokes and deletes, and says the cluster may be left behind', async () =>
    {
        kindFactory.FailWith = new KindError('docker down')
        const r = await Harness.Send(host, 'DELETE', '/api/hives/kind1?force=true')
        assert.equal(r.status, 200)
        assert.deepEqual(events, ['DeregisterHive', 'DeleteHive'])
        assert.match((JSON.parse(r.body) as DeleteBody).notice ?? '', /kind cluster may be left behind/)
        assert.equal(directory.GetHive('kind1'), undefined)
        await assert.rejects(deployments.VerifyAgentToken('kind1', tokens.get('kind1')!), HiveNotRegisteredError)
    })

    it('a non-exec destroy failure is a real server error (500), not a delete-anyway case', async () =>
    {
        kindFactory.FailWith = new TypeError('bug')
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/kind1')).status, 500)
        assert.ok(directory.GetHive('kind1') !== undefined)
    })

    it('token revoked but the record delete failed: the token is already dead and a retry completes', async () =>
    {
        const remove = directory.DeleteHive.bind(directory)
        let failOnce = true
        directory.DeleteHive = async (id: string) =>
        {
            events.push('DeleteHive')
            if (failOnce)
            {
                failOnce = false
                throw new Error('disk full')
            }
            await remove(id)
        }
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/local1')).status, 500)
        assert.ok(directory.GetHive('local1') !== undefined)
        await assert.rejects(deployments.VerifyAgentToken('local1', tokens.get('local1')!), HiveNotRegisteredError)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/local1')).status, 200)
        assert.equal(directory.GetHive('local1'), undefined)
    })

    it('nothing retained exists: an empty retained list and no audit note', async () =>
    {
        const r = await Harness.Send(host, 'DELETE', '/api/hives/local1')
        assert.deepEqual((JSON.parse(r.body) as DeleteBody).retained, [])
        assert.equal(audit.Recent(10).find(e => e.method === 'DELETE')?.note, undefined)
    })

    it('two hives of one tenant on one context: deleting the non-owner leaves the owner\'s tenant-admin credential copies', async () =>
    {
        await directory.CreateHive({ id: 'owner1', tenantId: 't-local1', displayName: 'owner', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        orchestrators.Kubectl.Objects.set('deployment/' + K8sManifestBuilder.TenantAdminNameOf('t-local1'), JSON.stringify({ metadata: { name: 'x', labels: { 'pragmatic/hive': 'owner1' } } }))
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/local1')).status, 200)
        assert.ok(!orchestrators.Kubectl.Calls.some(c => c[1] === new K8sManifestBuilder().TenantConsoleRemovalManifest('t-local1', 'local1')))
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/owner1')).status, 200)
        assert.ok(orchestrators.Kubectl.Calls.some(c => c[1] === new K8sManifestBuilder().TenantConsoleRemovalManifest('t-local1', 'owner1')))
    })

    it('a non-Local hive: no cluster is touched, the token is deregistered and the record deleted', async () =>
    {
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/aks1')).status, 200)
        assert.deepEqual(events, ['DestroyHiveCluster', 'DeregisterHive', 'DeleteHive'])
        assert.deepEqual(orchestrators.Kubectl.Calls, [])
        await assert.rejects(deployments.VerifyAgentToken('aks1', tokens.get('aks1')!), HiveNotRegisteredError)
    })

    it('a host without an uninstaller still deregisters on delete', async () =>
    {
        await host.Close()
        host = Make(undefined)
        await host.Listen(0, '127.0.0.1')
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/local1')).status, 200)
        assert.deepEqual(events, ['DestroyHiveCluster', 'DeregisterHive', 'DeleteHive'])
        await assert.rejects(deployments.VerifyAgentToken('local1', tokens.get('local1')!), HiveNotRegisteredError)
    })

    it('a deregistration failure leaves the record for retry', async () =>
    {
        deployments.DeregisterHive = async () => { events.push('DeregisterHive'); throw new Error('disk full') }
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/local1')).status, 500)
        assert.ok(directory.GetHive('local1') !== undefined)
        assert.ok(!events.includes('DeleteHive'))
    })
})
