import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSession, type OperatorSummary } from '../operator-identity.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { RolloutFixture } from './rollout-fixture.js'
import { HiveObservationRegistry } from '../hive-observation-record.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import type { IKubectl } from '../kubectl.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord } from '../platform-records.js'

type Reply = { status: number; body: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly Token = 'valid-token'

    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        return { token: FakeOperator.Token, expiresAt: new Date(Date.now() + 3600000) }
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        return token === FakeOperator.Token ? { email: 'op@example.com', principalId: 'p1', role: OperatorRole.Full } : null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        return []
    }

    public async SetOperatorRole(_email: string, _role: OperatorRole, _actorPrincipalId: string): Promise<void>
    {
    }

    public async ResetOperatorPassword(_email: string): Promise<string>
    {
        return ''
    }

    public async SetOperatorDisabled(_email: string, _disabled: boolean, _actorPrincipalId: string): Promise<void>
    {
    }

    public async RevokeOperatorSessions(_email: string): Promise<void>
    {
    }

    public async CreateOperator(_email: string, _password: string, _role: OperatorRole): Promise<void>
    {
    }

    public async Revoke(_token: string): Promise<void>
    {
    }
}

class FakeOrchestrator implements IHiveOrchestrator
{
    public readonly Kubectl = undefined as unknown as IKubectl
    public async Apply(_w: EnvironmentWorkload): Promise<void>
    {
    }

    public async WaitHealthy(_w: EnvironmentWorkload): Promise<void>
    {
    }

    public async Health(w: EnvironmentWorkload): Promise<WorkloadHealth>
    {
        return { ready: w.environmentName === 'dev-a', runningImage: 'img:' + w.environmentName, detail: 'ok ' + w.hiveId }
    }

    public async Roll(_w: EnvironmentWorkload, _image: string): Promise<void>
    {
    }

    public async Scale(_w: EnvironmentWorkload, _replicas: number): Promise<void>
    {
    }

    public async Teardown(_w: EnvironmentWorkload): Promise<void>
    {
    }
}

class FakeFactory extends HiveOrchestratorFactory
{
    public override For(hive: HiveRecord): IHiveOrchestrator
    {
        if (hive.cluster.backend !== HiveBackend.Local)
        {
            throw new UnsupportedBackendError(hive.cluster.backend, hive.cluster.mode)
        }
        return new FakeOrchestrator()
    }
}

class FakeService
{
    public static Record(name: string, hiveId: string | undefined): EnvironmentRecord
    {
        return {
            name, type: EnvType.Development, template: Template.DevBlank, environmentId: 't1', hiveId, hostPort: 8101,
            containerName: 'c-' + name, volumeName: 'v-' + name, bundleDir: '/b/' + name, createdAt: '2026-01-01T00:00:00Z', status: EnvStatus.Running
        }
    }

    public List(): readonly EnvironmentRecord[]
    {
        return [FakeService.Record('dev-a', 'local1'), FakeService.Record('dev-b', 'local1'), FakeService.Record('dev-c', 'cloud1'), FakeService.Record('dev-d', undefined)]
    }
}

class Harness
{
    public static Get(host: ControlPlaneHost, path: string, authed: boolean = true): Promise<Reply>
    {
        const headers: Record<string, string> = {}
        if (authed)
        {
            headers.cookie = 'cp_session=' + FakeOperator.Token
        }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method: 'GET', path, headers }, res =>
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

describe('ControlPlaneHost hive health route', () =>
{
    let host: ControlPlaneHost
    let observations: HiveObservationRegistry
    let deployments: PlatformDeploymentRegistry
    let parent: string

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-hive-health-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'acme', displayName: 'Acme' })
        await directory.CreateTenant({ id: 't1', clientId: 'acme', displayName: 'T' })
        await directory.CreateHive({ id: 'local1', tenantId: 't1', displayName: 'L', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        await directory.CreateHive({ id: 'cloud1', tenantId: 't1', displayName: 'C', cluster: { backend: HiveBackend.Aks, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        observations = new HiveObservationRegistry(join(parent, 'observations.json'))
        await observations.Load()
        const factory = new FakeFactory()
        deployments = await RolloutFixture.Create(parent, directory, factory)
        host = new ControlPlaneHost(new FakeService() as unknown as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, deployments, new FakeProvisioning(directory).AsService(), observations)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('returns the stored observation for a hive that reported, with no secret fields', async () =>
    {
        const reported = [
            { environmentName: 'dev-x', ready: true, runningImage: 'img:x', detail: 'reported' },
            { environmentName: 'dev-y', ready: false, runningImage: 'img:y', detail: 'down' }
        ]
        await observations.RecordSnapshot('local1', reported)
        const r = await Harness.Get(host, '/api/hives/local1/health')
        assert.equal(r.status, 200)
        const arr = JSON.parse(r.body)
        assert.deepEqual(arr, reported)
        assert.deepEqual(Object.keys(arr[0]).sort(), ['detail', 'environmentName', 'ready', 'runningImage'])
        assert.doesNotMatch(r.body, /secret|password|token/i)
    })

    it('returns an empty list with 200 for a known hive that never reported', async () =>
    {
        const r = await Harness.Get(host, '/api/hives/local1/health')
        assert.equal(r.status, 200)
        assert.deepEqual(JSON.parse(r.body), [])
    })

    it('does not poll the orchestrator: an unsupported-backend hive with no report is 200 []', async () =>
    {
        const r = await Harness.Get(host, '/api/hives/cloud1/health')
        assert.equal(r.status, 200)
        assert.deepEqual(JSON.parse(r.body), [])
    })

    it('returns 404 for an unknown hive', async () =>
    {
        assert.equal((await Harness.Get(host, '/api/hives/nope/health')).status, 404)
    })

    it('challenges an unauthenticated request with 401', async () =>
    {
        assert.equal((await Harness.Get(host, '/api/hives/local1/health', false)).status, 401)
    })

    it('serves the observation series newest-first and the fleet still reports the latest', async () =>
    {
        const one = [{ environmentName: 'dev-x', ready: true, runningImage: 'img:1', detail: 'first' }]
        const two = [{ environmentName: 'dev-x', ready: false, runningImage: 'img:2', detail: 'second' }]
        await observations.RecordSnapshot('local1', one)
        await observations.RecordSnapshot('local1', two)
        const r = await Harness.Get(host, '/api/hives/local1/observations')
        assert.equal(r.status, 200)
        const arr = JSON.parse(r.body)
        assert.equal(arr.length, 2)
        assert.deepEqual(arr[0].environments, two)
        assert.deepEqual(arr[1].environments, one)
        assert.equal(JSON.parse((await Harness.Get(host, '/api/hives/local1/observations?limit=1')).body).length, 1)
        const fleet = JSON.parse((await Harness.Get(host, '/api/fleet')).body)
        assert.equal(fleet.find((h: { id: string }) => h.id === 'local1').environments[0].detail, 'second')
        assert.equal((await Harness.Get(host, '/api/hives/nope/observations')).status, 404)
        assert.equal((await Harness.Get(host, '/api/hives/local1/observations', false)).status, 401)
    })

    it('serves the hive ledger newest-first with limit, 404 unknown hive, 401 unauthenticated', async () =>
    {
        await deployments.Publish('1.0.0', 'img:1')
        await deployments.Publish('2.0.0', 'img:2')
        await deployments.Gate('t1', '1.0.0')
        await deployments.Gate('t1', '2.0.0')
        await deployments.RecordAdoption('local1', '1.0.0')
        await new Promise(r => setTimeout(r, 3))
        await deployments.RecordAdoption('local1', '2.0.0')
        const r = await Harness.Get(host, '/api/hives/local1/ledger')
        assert.equal(r.status, 200)
        const arr = JSON.parse(r.body)
        assert.deepEqual(arr.map((e: { version: string }) => e.version), ['2.0.0', '1.0.0'])
        assert.equal(arr[0].action, 'adopted')
        assert.equal(arr[0].tenantId, 't1')
        assert.equal(JSON.parse((await Harness.Get(host, '/api/hives/local1/ledger?limit=1')).body).length, 1)
        assert.deepEqual(JSON.parse((await Harness.Get(host, '/api/hives/cloud1/ledger')).body), [])
        assert.equal((await Harness.Get(host, '/api/hives/nope/ledger')).status, 404)
        assert.equal((await Harness.Get(host, '/api/hives/local1/ledger', false)).status, 401)
    })
})
