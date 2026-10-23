import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
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
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import { RolloutFixture } from './rollout-fixture.js'

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
        return token === FakeOperator.Token ? { email: 'op@example.com', principalId: 'p1' } : null
    }

    public async Revoke(_token: string): Promise<void>
    {
    }
}

class Harness
{
    public static Send(host: ControlPlaneHost, method: string, path: string, body?: unknown, authed: boolean = true): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (authed)
        {
            headers.cookie = 'cp_session=' + FakeOperator.Token
        }
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
            req.end(body === undefined ? undefined : JSON.stringify(body))
        })
    }
}

describe('ControlPlaneHost rollout routes', () =>
{
    let host: ControlPlaneHost
    let parent: string
    let deployments: PlatformDeploymentRegistry

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-rollout-'))
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
        deployments = await RolloutFixture.Create(parent, directory, factory)
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, factory, deployments, new FakeProvisioning(directory).AsService())
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('publishes a manifest, and lists it for a tenant only once gated', async () =>
    {
        const published = await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1', notes: 'first' })
        assert.equal(published.status, 201)
        assert.equal((JSON.parse(published.body) as { id: string }).id, '1.0.0')
        const before = await Harness.Send(host, 'GET', '/api/tenants/t1/manifests')
        assert.equal(before.status, 200)
        assert.deepEqual(JSON.parse(before.body), [])
        const gated = await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '1.0.0' })
        assert.equal(gated.status, 204)
        const after = JSON.parse((await Harness.Send(host, 'GET', '/api/tenants/t1/manifests')).body) as { id: string; image: string }[]
        assert.equal(after.length, 1)
        assert.equal(after[0]!.image, 'img:1')
        const ungated = await Harness.Send(host, 'DELETE', '/api/tenants/t1/gating/1.0.0')
        assert.equal(ungated.status, 204)
        assert.deepEqual(JSON.parse((await Harness.Send(host, 'GET', '/api/tenants/t1/manifests')).body), [])
    })

    it('withdraws and restores a published version through the operator route, surfacing on the tenant listing', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '1.0.0' })
        const withdrawn = await Harness.Send(host, 'POST', '/api/manifests/1.0.0/withdrawn')
        assert.equal(withdrawn.status, 200)
        assert.equal((JSON.parse(withdrawn.body) as { withdrawn: boolean }).withdrawn, true)
        const listed = JSON.parse((await Harness.Send(host, 'GET', '/api/tenants/t1/manifests')).body) as { id: string; withdrawn?: boolean }[]
        assert.equal(listed[0]!.withdrawn, true)
        const restored = await Harness.Send(host, 'DELETE', '/api/manifests/1.0.0/withdrawn')
        assert.equal(restored.status, 200)
        assert.equal((JSON.parse(restored.body) as { withdrawn: boolean }).withdrawn, false)
    })

    it('answers a withdrawn toggle for an unknown version with 404', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/manifests/9.9.9/withdrawn')).status, 404)
    })

    it('records the selected target and reports the rollout status', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '1.0.0' })
        const selected = await Harness.Send(host, 'POST', '/api/hives/local1/target', { version: '1.0.0' })
        assert.equal(selected.status, 204)
        assert.deepEqual(deployments.TargetFor('local1'), { version: '1.0.0', image: 'img:1' })
        const status = await Harness.Send(host, 'GET', '/api/hives/local1/rollout')
        assert.equal(status.status, 200)
        assert.deepEqual(JSON.parse(status.body), { targetVersion: '1.0.0', environments: [] })
    })

    it('reveals the agent token only in the registration response, never in a stored record', async () =>
    {
        const reply = await Harness.Send(host, 'POST', '/api/hives/local1/rollout-registration')
        assert.equal(reply.status, 201)
        const token = (JSON.parse(reply.body) as { token: string }).token
        assert.ok(token.length > 0)
        await deployments.VerifyAgentToken('local1', token)
        for (const file of readdirSync(parent).filter(f => f.endsWith('.json')))
        {
            assert.ok(!readFileSync(join(parent, file), 'utf8').includes(token), file)
        }
        const status = await Harness.Send(host, 'GET', '/api/hives/local1/rollout')
        assert.ok(!status.body.includes(token))
    })

    it('answers an unknown hive registration with 404', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/nope/rollout-registration')).status, 404)
    })

    it('challenges every rollout route with 401 when unauthenticated', async () =>
    {
        const calls: [string, string, unknown][] = [
            ['POST', '/api/manifests', { version: 'v', image: 'i' }],
            ['POST', '/api/manifests/v/withdrawn', undefined],
            ['DELETE', '/api/manifests/v/withdrawn', undefined],
            ['GET', '/api/tenants/t1/manifests', undefined],
            ['POST', '/api/tenants/t1/gating', { version: 'v' }],
            ['DELETE', '/api/tenants/t1/gating/v', undefined],
            ['POST', '/api/hives/local1/target', { version: 'v' }],
            ['GET', '/api/hives/local1/rollout', undefined],
            ['POST', '/api/hives/local1/rollout-registration', undefined]
        ]
        for (const [method, path, body] of calls)
        {
            assert.equal((await Harness.Send(host, method, path, body, false)).status, 401, method + ' ' + path)
        }
    })

    it('maps an ungated version to 403, an unknown manifest to 404, and a duplicate publish to 409', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '2.0.0', image: 'img:2' })
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/local1/target', { version: '2.0.0' })).status, 403)
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/local1/target', { version: '9.9.9' })).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '9.9.9' })).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/nope/target', { version: '2.0.0' })).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/manifests', { version: '2.0.0', image: 'img:2' })).status, 409)
    })

    it('rejects a malformed publish or target body with 400', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/manifests', { version: '3.0.0' })).status, 400)
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/local1/target', {})).status, 400)
    })
})
