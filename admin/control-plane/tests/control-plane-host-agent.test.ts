import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import type { IOperatorIdentity, OperatorPrincipal, OperatorSession } from '../operator-identity.js'
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
        return token === FakeOperator.Token ? { email: 'op@example.com', principalId: 'p1' } : null
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

describe('ControlPlaneHost agent routes (machine credential)', () =>
{
    const TargetPath = '/api/hives/local1/agent/target'
    const ReportPath = '/api/hives/local1/agent/report'
    const RolloutPath = '/api/hives/local1/rollout'
    const Report = { environmentName: 'prod', runningImage: 'img:1', ready: true }
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
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, factory, deployments, new FakeProvisioning(directory).AsService())
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

    it('serves the target to a correct bearer without any operator session', async () =>
    {
        assert.equal((await Harness.Send(host, 'GET', TargetPath, { authorization: 'Bearer ' + token })).status, 404)
        await Harness.Send(host, 'POST', '/api/hives/local1/target', { cookie: true, body: { version: '1.0.0' } })
        const reply = await Harness.Send(host, 'GET', TargetPath, { authorization: 'Bearer ' + token })
        assert.equal(reply.status, 200)
        assert.deepEqual(JSON.parse(reply.body), { version: '1.0.0', image: 'img:1' })
    })

    it('rejects a wrong, missing or malformed bearer with 401 and never echoes a token', async () =>
    {
        const wrong = await Harness.Send(host, 'GET', TargetPath, { authorization: 'Bearer wrong-token-value' })
        const missing = await Harness.Send(host, 'GET', TargetPath)
        const malformed = await Harness.Send(host, 'GET', TargetPath, { authorization: 'Basic ' + token })
        const bare = await Harness.Send(host, 'GET', TargetPath, { authorization: token })
        for (const r of [wrong, missing, malformed, bare])
        {
            assert.equal(r.status, 401)
            assert.ok(!r.body.includes(token))
            assert.ok(!r.body.includes('wrong-token-value'))
        }
    })

    it('does not accept an operator session cookie alone on the agent routes', async () =>
    {
        assert.equal((await Harness.Send(host, 'GET', TargetPath, { cookie: true })).status, 401)
        assert.equal((await Harness.Send(host, 'POST', ReportPath, { cookie: true, body: Report })).status, 401)
    })

    it('does not accept the agent bearer on operator routes', async () =>
    {
        const auth = 'Bearer ' + token
        assert.equal((await Harness.Send(host, 'GET', RolloutPath, { authorization: auth })).status, 401)
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/local1/target', { authorization: auth, body: { version: '1.0.0' } })).status, 401)
    })

    it('rejects a wrong method on an agent path without falling through to static serving', async () =>
    {
        const del = await Harness.Send(host, 'DELETE', TargetPath)
        assert.equal(del.status, 401)
        assert.ok(!del.body.includes('portal'))
        const get = await Harness.Send(host, 'GET', ReportPath, { authorization: 'Bearer ' + token })
        assert.equal(get.status, 401)
    })

    it('marks the token-registration response no-store', async () =>
    {
        const reply = await Harness.Send(host, 'POST', '/api/hives/local1/rollout-registration', { cookie: true })
        assert.equal(reply.status, 201)
        assert.equal(reply.cacheControl, 'no-store')
    })

    it('answers 404 for an unregistered hive without echoing the token', async () =>
    {
        const reply = await Harness.Send(host, 'GET', '/api/hives/nope/agent/target', { authorization: 'Bearer ' + token })
        assert.equal(reply.status, 404)
        assert.ok(!reply.body.includes(token))
    })

    it('records a report for a correct bearer, visible via the operator rollout route', async () =>
    {
        await Harness.Send(host, 'POST', '/api/hives/local1/target', { cookie: true, body: { version: '1.0.0' } })
        const reply = await Harness.Send(host, 'POST', ReportPath, { authorization: 'Bearer ' + token, body: Report })
        assert.equal(reply.status, 204)
        const status = JSON.parse((await Harness.Send(host, 'GET', RolloutPath, { cookie: true })).body) as { environments: unknown[] }
        assert.deepEqual(status.environments, [{ environmentName: 'prod', runningImage: 'img:1', obsolete: false, ready: true }])
    })

    it('rejects a report with a bad bearer (nothing recorded) and a malformed body with 400', async () =>
    {
        const bad = await Harness.Send(host, 'POST', ReportPath, { authorization: 'Bearer nope', body: Report })
        assert.equal(bad.status, 401)
        assert.ok(!bad.body.includes(token))
        const status = JSON.parse((await Harness.Send(host, 'GET', RolloutPath, { cookie: true })).body) as { environments: unknown[] }
        assert.deepEqual(status.environments, [])
        const invalid = await Harness.Send(host, 'POST', ReportPath, { authorization: 'Bearer ' + token, body: { environmentName: 'prod' } })
        assert.equal(invalid.status, 400)
    })
})
