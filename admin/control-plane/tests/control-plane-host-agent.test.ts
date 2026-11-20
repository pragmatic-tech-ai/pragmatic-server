import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSummary } from '../operator-identity.js'
import { HostSessions } from './host-sessions.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import { RolloutFixture } from './rollout-fixture.js'

type Reply = { status: number; body: string; cacheControl?: string | string[] }
type SendOptions = { body?: unknown; cookie?: boolean; authorization?: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly Token = 'valid-token'
    public static readonly Principal: OperatorPrincipal = { email: 'op@example.com', principalId: 'p1', role: OperatorRole.Full }

    public async Verify(_email: string, _password: string): Promise<OperatorPrincipal | null>
    {
        return FakeOperator.Principal
    }

    public async PrincipalOf(principalId: string): Promise<OperatorPrincipal | null>
    {
        return principalId === FakeOperator.Principal.principalId ? FakeOperator.Principal : null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        return []
    }

    public async SetOperatorRole(_email: string, _role: OperatorRole, _actorPrincipalId: string): Promise<void>
    {
    }

    public async ChangeOwnPassword(_p: string, _c: string, _n: string): Promise<boolean> { return false }
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
}

class Harness
{
    public static Send(host: ControlPlaneHost, method: string, path: string, opts: SendOptions = {}): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (opts.cookie === true)
        {
            headers.cookie = 'cp_session=' + FakeOperator.Token
        }
        if (opts.authorization !== undefined)
        {
            headers.authorization = opts.authorization
        }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, cacheControl: res.headers['cache-control'], body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body))
        })
    }
}

describe('ControlPlaneHost hive token registration (operator action)', () =>
{
    const RolloutPath = '/api/hives/local1/rollout'
    let host: ControlPlaneHost
    let parent: string
    let token: string

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-agent-'))
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
        const factory = new HiveOrchestratorFactory()
        const deployments = await RolloutFixture.Create(parent, directory, factory)
        const sessions = await HostSessions.With(FakeOperator.Token, FakeOperator.Principal)
        host = new ControlPlaneHost({ Service: {} as IEnvironmentService, Graphs: {} as IGraphService, PortalRoot: root, Operator: new FakeOperator(), Sessions: sessions.Sessions,
            Directory: directory, Deployments: deployments, Provisioning: new FakeProvisioning(directory).AsService(), Observations: RolloutFixture.Observations(parent) })
        await host.Listen(0, '127.0.0.1')
        token = (JSON.parse((await Harness.Send(host, 'POST', '/api/hives/local1/rollout-registration', { cookie: true })).body) as { token: string }).token
        await deployments.Publish('1.0.0', 'img:1')
        await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { cookie: true, body: { version: '1.0.0' } })
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('does not accept the agent bearer on operator routes', async () =>
    {
        const auth = 'Bearer ' + token
        assert.equal((await Harness.Send(host, 'GET', RolloutPath, { authorization: auth })).status, 401)
    })

    it('marks the token-registration response no-store', async () =>
    {
        const reply = await Harness.Send(host, 'POST', '/api/hives/local1/rollout-registration', { cookie: true })
        assert.equal(reply.status, 201)
        assert.equal(reply.cacheControl, 'no-store')
    })
})
