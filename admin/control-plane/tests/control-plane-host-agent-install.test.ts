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
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import { HiveAgentInstaller, InstallState, InstallStep, SystemInstallClock, type InstallStatus } from '../hive-agent-installer.js'
import { KubectlError, type IKubectl } from '../kubectl.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import type { HiveObservationRegistry } from '../hive-observation-record.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'

type Reply = { status: number; body: string; cacheControl?: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly FullToken = 'full-token'
    public static readonly ReadOnlyToken = 'readonly-token'

    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        return null
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        if (token === FakeOperator.FullToken)
        {
            return { email: 'op@example.com', principalId: 'p1', role: OperatorRole.Full }
        }
        return token === FakeOperator.ReadOnlyToken ? { email: 'ro@example.com', principalId: 'p2', role: OperatorRole.ReadOnly } : null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]> { return [] }
    public async SetOperatorRole(_e: string, _r: OperatorRole, _a: string): Promise<void> { }
    public async ResetOperatorPassword(_e: string): Promise<string> { return '' }
    public async SetOperatorDisabled(_e: string, _d: boolean, _a: string): Promise<void> { }
    public async RevokeOperatorSessions(_e: string): Promise<void> { }
    public async CreateOperator(_e: string, _p: string, _r: OperatorRole): Promise<void> { }
    public async Revoke(_t: string): Promise<void> { }
}

// Records every kubectl call; the Apply manifests are what kubectl would read on stdin.
class FakeKubectl implements IKubectl
{
    public readonly Applied: string[] = []
    public readonly ServerApplied: string[] = []
    public readonly Args: string[][] = []
    public ApplyError: Error | undefined
    public ServerApplyError: Error | undefined

    public async Apply(manifestJson: string): Promise<void>
    {
        this.Applied.push(manifestJson)
        if (this.ApplyError !== undefined)
        {
            throw this.ApplyError
        }
    }

    public async ApplyServerSide(manifestJson: string): Promise<void>
    {
        this.ServerApplied.push(manifestJson)
        if (this.ServerApplyError !== undefined)
        {
            throw this.ServerApplyError
        }
    }

    public async RolloutRestartSelector(n: string, s: string): Promise<void> { this.Args.push([n, s]) }

    public async RolloutStatus(n: string, d: string): Promise<void> { this.Args.push([n, d]) }
    public async SetImage(n: string, d: string, c: string, i: string): Promise<void> { this.Args.push([n, d, c, i]) }
    public async Scale(n: string, d: string, r: number): Promise<void> { this.Args.push([n, d, String(r)]) }
    public async ScaleStatefulSet(n: string, s: string, r: number): Promise<void> { this.Args.push([n, s, String(r)]) }
    public async RolloutRestart(n: string, d: string): Promise<void> { this.Args.push([n, d]) }
    public async Get(n: string, r: string): Promise<string> { this.Args.push([n, r]); return '{}' }
    public async DeleteNamespace(n: string): Promise<void> { this.Args.push([n]) }
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
    public readonly Kubectl = new FakeKubectl()

    public For(_hive: HiveRecord): IHiveOrchestrator
    {
        return new FakeOrchestrator(this.Kubectl)
    }
}

class Harness
{
    public static readonly ChannelUrl = 'http://host.docker.internal:7001'

    public static Send(host: ControlPlaneHost, method: string, path: string, token: string = FakeOperator.FullToken): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json', cookie: 'cp_session=' + token }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, cacheControl: res.headers['cache-control'] as string | undefined, body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end()
        })
    }

    // Polls GET agent-install until the install leaves Installing.
    public static async Settled(host: ControlPlaneHost, hiveId: string): Promise<{ reply: Reply; status: InstallStatus }>
    {
        for (let i = 0; i < 400; i++)
        {
            const reply = await Harness.Send(host, 'GET', '/api/hives/' + hiveId + '/agent-install')
            const status = JSON.parse(reply.body) as InstallStatus
            if (status.state !== InstallState.Installing)
            {
                return { reply, status }
            }
            await new Promise(resolve => setTimeout(resolve, 5))
        }
        throw new Error('install never settled')
    }
}

describe('ControlPlaneHost automatic agent install', () =>
{
    let host: ControlPlaneHost
    let parent: string
    let root: string
    let directory: PlatformDirectory
    let deployments: PlatformDeploymentRegistry
    let observations: HiveObservationRegistry
    let orchestrators: FakeOrchestrators

    const Make = (installer: HiveAgentInstaller | undefined): ControlPlaneHost =>
        new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, deployments,
            new FakeProvisioning(directory).AsService(), observations, undefined, false, undefined, undefined, undefined, [], undefined,
            undefined, undefined, undefined, Harness.ChannelUrl, installer)

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-agent-install-'))
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
        await directory.CreateTenant({ id: 't1', clientId: 'acme', displayName: 'T' })
        await directory.CreateTenant({ id: 't2', clientId: 'acme', displayName: 'T2' })
        await directory.CreateHive({ id: 'local1', tenantId: 't1', displayName: 'L', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        await directory.CreateHive({ id: 'aks1', tenantId: 't2', displayName: 'A', cluster: { backend: HiveBackend.Aks, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        observations = RolloutFixture.Observations(parent)
        orchestrators = new FakeOrchestrators()
        const installer = new HiveAgentInstaller(directory, orchestrators, deployments, observations, Harness.ChannelUrl, new SystemInstallClock(), { pollIntervalMs: 5, timeoutMs: 5000 })
        host = Make(installer)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('POST starts the install (202, no-store, no token); the hive checks in with the stored token and GET ends Connected', async () =>
    {
        const started = await Harness.Send(host, 'POST', '/api/hives/local1/agent-install')
        assert.equal(started.status, 202)
        assert.equal(started.cacheControl, 'no-store')
        const first = JSON.parse(started.body) as InstallStatus
        assert.equal(first.state, InstallState.Installing)
        // Wait for the token Secret to be applied, then read the token the way the agent would: from the Secret.
        for (let i = 0; i < 400 && orchestrators.Kubectl.Args.length < 1; i++)
        {
            await new Promise(resolve => setTimeout(resolve, 5))
        }
        const secret = JSON.parse(orchestrators.Kubectl.ServerApplied[0]!) as { kind: string; stringData: { token: string } }
        assert.equal(secret.kind, 'Secret')
        const token = secret.stringData.token
        await deployments.VerifyAgentToken('local1', token)
        assert.deepEqual(orchestrators.Kubectl.Args, [['pragmatic-system', 'pragmatic/hive=local1']])
        await new Promise(resolve => setTimeout(resolve, 5))
        await observations.RecordSnapshot('local1', [])
        const { reply, status } = await Harness.Settled(host, 'local1')
        assert.equal(reply.status, 200)
        assert.equal(reply.cacheControl, 'no-store')
        assert.equal(status.state, InstallState.Connected)
        assert.equal(status.step, InstallStep.WaitingForCheckIn)
        assert.ok(!started.body.includes(token))
        assert.ok(!reply.body.includes(token))
        assert.ok(!JSON.stringify(orchestrators.Kubectl.Args).includes(token))
    })

    it('a second POST while one is running -> 409', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/local1/agent-install')).status, 202)
        const again = await Harness.Send(host, 'POST', '/api/hives/local1/agent-install')
        assert.equal(again.status, 409)
        assert.match(JSON.parse(again.body).error, /already running/)
    })

    it('a failed Secret store leaves the hive\'s previous agent token valid', async () =>
    {
        const old = JSON.parse((await Harness.Send(host, 'POST', '/api/hives/local1/rollout-registration')).body).token as string
        orchestrators.Kubectl.ServerApplyError = new KubectlError('error: secrets "pragmatic-hive-local1-agent-token" is forbidden')
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/local1/agent-install')).status, 202)
        const { status } = await Harness.Settled(host, 'local1')
        assert.equal(status.state, InstallState.Failed)
        assert.equal(status.step, InstallStep.StoringToken)
        await deployments.VerifyAgentToken('local1', old)
    })

    it('while an install runs, reissuing the token and deleting the hive are refused (409)', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/local1/agent-install')).status, 202)
        const reissue = await Harness.Send(host, 'POST', '/api/hives/local1/rollout-registration')
        assert.equal(reissue.status, 409)
        assert.match(JSON.parse(reissue.body).error, /install is running/)
        assert.ok(!reissue.body.includes('token":'))
        const del = await Harness.Send(host, 'DELETE', '/api/hives/local1')
        assert.equal(del.status, 409)
        assert.match(JSON.parse(del.body).error, /install is running/)
        assert.ok(directory.GetHive('local1') !== undefined)
        // Other hives are unaffected.
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/aks1/rollout-registration')).status, 201)
    })

    it('a kubectl failure surfaces as Failed with the redacted text and never the token; Retry restarts it', async () =>
    {
        orchestrators.Kubectl.ApplyError = new KubectlError('Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused')
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/local1/agent-install')).status, 202)
        const { status } = await Harness.Settled(host, 'local1')
        assert.equal(status.state, InstallState.Failed)
        assert.equal(status.step, InstallStep.ApplyingAgent)
        assert.match(status.error ?? '', /connection refused/)
        orchestrators.Kubectl.ApplyError = undefined
        const retried = await Harness.Send(host, 'POST', '/api/hives/local1/agent-install')
        assert.equal(retried.status, 202)
        assert.equal((JSON.parse(retried.body) as InstallStatus).state, InstallState.Installing)
    })

    it('GET before any install -> 404; unknown hive -> 404 for both; malformed id -> 400', async () =>
    {
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/local1/agent-install')).status, 404)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/nope/agent-install')).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/nope/agent-install')).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/%E0%A4%A/agent-install')).status, 400)
    })

    it('a non-Local hive -> 409 and nothing is applied', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/hives/aks1/agent-install')
        assert.equal(r.status, 409)
        assert.match(JSON.parse(r.body).error, /not available for this hive/)
        assert.deepEqual(orchestrators.Kubectl.Applied, [])
    })

    it('a ReadOnly operator may read the status but not start an install (403)', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/hives/local1/agent-install', FakeOperator.ReadOnlyToken)
        assert.equal(r.status, 403)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/local1/agent-install', FakeOperator.ReadOnlyToken)).status, 404)
        assert.deepEqual(orchestrators.Kubectl.Applied, [])
    })

    it('the bootstrap says autoInstall for a Local hive and not for a non-Local one', async () =>
    {
        assert.equal(JSON.parse((await Harness.Send(host, 'GET', '/api/hives/local1/bootstrap')).body).autoInstall, true)
        assert.equal(JSON.parse((await Harness.Send(host, 'GET', '/api/hives/aks1/bootstrap')).body).autoInstall, false)
    })

    it('without an installer: POST -> 409, GET -> 404 and the bootstrap says no autoInstall', async () =>
    {
        await host.Close()
        host = Make(undefined)
        await host.Listen(0, '127.0.0.1')
        const r = await Harness.Send(host, 'POST', '/api/hives/local1/agent-install')
        assert.equal(r.status, 409)
        assert.match(JSON.parse(r.body).error, /manually/)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/local1/agent-install')).status, 404)
        assert.equal(JSON.parse((await Harness.Send(host, 'GET', '/api/hives/local1/bootstrap')).body).autoInstall, false)
    })
})
