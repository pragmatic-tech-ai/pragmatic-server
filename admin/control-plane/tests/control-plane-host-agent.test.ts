import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSession } from '../operator-identity.js'
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

    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        return { token: FakeOperator.Token, expiresAt: new Date(Date.now() + 3600000) }
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        return token === FakeOperator.Token ? { email: 'op@example.com', principalId: 'p1', role: OperatorRole.Full } : null
    }

    public async CreateOperator(_email: string, _password: string, _role: OperatorRole): Promise<void>
    {
    }

    public async Revoke(_token: string): Promise<void>
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
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, deployments, new FakeProvisioning(directory).AsService(), RolloutFixture.Observations(parent))
        await host.Listen(0, '127.0.0.1')
        token = (JSON.parse((await Harness.Send(host, 'POST', '/api/hives/local1/rollout-registration', { cookie: true })).body) as { token: string }).token
        await Harness.Send(host, 'POST', '/api/manifests', { cookie: true, body: { version: '1.0.0', image: 'img:1' } })
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
