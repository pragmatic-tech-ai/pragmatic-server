import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
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
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import { RolloutFixture } from './rollout-fixture.js'

type Reply = { status: number; body: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly Token = 'valid-token'

    public Role: OperatorRole = OperatorRole.Full

    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        return { token: FakeOperator.Token, expiresAt: new Date(Date.now() + 3600000) }
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        return token === FakeOperator.Token ? { email: 'op@example.com', principalId: 'p1', role: this.Role } : null
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
    let operator: FakeOperator

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
        operator = new FakeOperator()
        const factory = new HiveOrchestratorFactory()
        deployments = await RolloutFixture.Create(parent, directory, factory)
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, operator, false, directory, deployments, new FakeProvisioning(directory).AsService(), RolloutFixture.Observations(parent))
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
        const withdrawn = await Harness.Send(host, 'POST', '/api/manifests/1.0.0/withdrawn', { reason: 'bad build' })
        assert.equal(withdrawn.status, 200)
        assert.equal((JSON.parse(withdrawn.body) as { withdrawn: boolean }).withdrawn, true)
        const listed = JSON.parse((await Harness.Send(host, 'GET', '/api/tenants/t1/manifests')).body) as { id: string; withdrawn?: boolean }[]
        assert.equal(listed[0]!.withdrawn, true)
        const restored = await Harness.Send(host, 'DELETE', '/api/manifests/1.0.0/withdrawn')
        assert.equal(restored.status, 200)
        assert.equal((JSON.parse(restored.body) as { withdrawn: boolean }).withdrawn, false)
    })

    it('lists every published manifest on GET /api/manifests, including withdrawn, and [] when none', async () =>
    {
        const empty = await Harness.Send(host, 'GET', '/api/manifests')
        assert.equal(empty.status, 200)
        assert.deepEqual(JSON.parse(empty.body), [])
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        await Harness.Send(host, 'POST', '/api/manifests', { version: '2.0.0', image: 'img:2' })
        await Harness.Send(host, 'POST', '/api/manifests/2.0.0/withdrawn', { reason: 'r' })
        const listed = await Harness.Send(host, 'GET', '/api/manifests')
        assert.equal(listed.status, 200)
        const all = JSON.parse(listed.body) as { id: string; withdrawn?: boolean }[]
        assert.deepEqual(all.map(m => m.id).sort(), ['1.0.0', '2.0.0'])
        assert.equal(all.find(m => m.id === '2.0.0')!.withdrawn, true)
        assert.notEqual(all.find(m => m.id === '1.0.0')!.withdrawn, true)
    })

    it('lists every gating record on GET /api/gating, and [] when none', async () =>
    {
        const empty = await Harness.Send(host, 'GET', '/api/gating')
        assert.equal(empty.status, 200)
        assert.deepEqual(JSON.parse(empty.body), [])
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        await Harness.Send(host, 'POST', '/api/manifests', { version: '2.0.0', image: 'img:2' })
        await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '1.0.0' })
        await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '2.0.0' })
        const listed = await Harness.Send(host, 'GET', '/api/gating')
        assert.equal(listed.status, 200)
        const all = JSON.parse(listed.body) as { tenantId: string; version: string }[]
        assert.deepEqual(all.map(g => g.version).sort(), ['1.0.0', '2.0.0'])
        assert.ok(all.every(g => g.tenantId === 't1'))
    })

    it('lists every selection record on GET /api/selections, and [] when none', async () =>
    {
        const empty = await Harness.Send(host, 'GET', '/api/selections')
        assert.equal(empty.status, 200)
        assert.deepEqual(JSON.parse(empty.body), [])
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '1.0.0' })
        await deployments.SelectTarget('local1', '1.0.0')
        const listed = await Harness.Send(host, 'GET', '/api/selections')
        assert.equal(listed.status, 200)
        const all = JSON.parse(listed.body) as { hiveId: string; targetVersion: string }[]
        assert.equal(all.length, 1)
        assert.equal(all[0]!.hiveId, 'local1')
        assert.equal(all[0]!.targetVersion, '1.0.0')
    })

    it('challenges unauthenticated GET /api/gating and /api/selections with 401', async () =>
    {
        assert.equal((await Harness.Send(host, 'GET', '/api/gating', undefined, false)).status, 401)
        assert.equal((await Harness.Send(host, 'GET', '/api/selections', undefined, false)).status, 401)
    })

    it('reports global rollout status on GET /api/rollouts, flagging an env running a stale image obsolete', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '1.0.0' })
        await deployments.SelectTarget('local1', '1.0.0')
        await deployments.ReportSnapshot('local1', [{ environmentName: 'prod', runningImage: 'img:0', ready: true, detail: 'ok' }])
        const reply = await Harness.Send(host, 'GET', '/api/rollouts')
        assert.equal(reply.status, 200)
        const all = JSON.parse(reply.body) as { hiveId: string; targetVersion?: string; environments: { environmentName: string; obsolete: boolean }[] }[]
        const entry = all.find(e => e.hiveId === 'local1')!
        assert.equal(entry.targetVersion, '1.0.0')
        assert.equal(entry.environments[0]!.environmentName, 'prod')
        assert.equal(entry.environments[0]!.obsolete, true)
    })

    it('reports an env running the target image and ready as not obsolete', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '1.0.0' })
        await deployments.SelectTarget('local1', '1.0.0')
        await deployments.ReportSnapshot('local1', [{ environmentName: 'prod', runningImage: 'img:1', ready: true, detail: 'ok' }])
        const all = JSON.parse((await Harness.Send(host, 'GET', '/api/rollouts')).body) as { hiveId: string; environments: { obsolete: boolean; ready: boolean }[] }[]
        const env = all.find(e => e.hiveId === 'local1')!.environments[0]!
        assert.equal(env.obsolete, false)
        assert.equal(env.ready, true)
    })

    it('reports a hive with no selected target without a targetVersion and with no obsolete env', async () =>
    {
        await deployments.ReportSnapshot('local1', [{ environmentName: 'prod', runningImage: 'img:0', ready: false, detail: 'x' }])
        const reply = await Harness.Send(host, 'GET', '/api/rollouts')
        const all = JSON.parse(reply.body) as { hiveId: string; targetVersion?: string; environments: { obsolete: boolean }[] }[]
        const entry = all.find(e => e.hiveId === 'local1')!
        assert.equal(entry.targetVersion, undefined)
        assert.ok(!('targetVersion' in entry))
        assert.equal(entry.environments[0]!.obsolete, false)
    })

    it('exposes exactly the documented keys on GET /api/rollouts and leaks nothing else', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '1.0.0' })
        await deployments.SelectTarget('local1', '1.0.0')
        await deployments.ReportSnapshot('local1', [{ environmentName: 'prod', runningImage: 'img:1', ready: true, detail: 'secret-detail' }])
        const all = JSON.parse((await Harness.Send(host, 'GET', '/api/rollouts')).body) as Record<string, unknown>[]
        const entry = all.find(e => e.hiveId === 'local1')!
        assert.deepEqual(Object.keys(entry).sort(), ['environments', 'hiveId', 'targetVersion'])
        const env = (entry.environments as Record<string, unknown>[])[0]!
        assert.deepEqual(Object.keys(env).sort(), ['environmentName', 'obsolete', 'ready', 'runningImage'])
    })

    it('serves GET /api/rollouts to a ReadOnly operator (not Full-gated) and challenges anonymous with 401', async () =>
    {
        operator.Role = OperatorRole.ReadOnly
        assert.equal((await Harness.Send(host, 'GET', '/api/rollouts')).status, 200)
        assert.equal((await Harness.Send(host, 'GET', '/api/rollouts', undefined, false)).status, 401)
    })

    it('publish accepts a channel and passes it through', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1', channel: 'early' })
        assert.equal(r.status, 201)
        const all = JSON.parse((await Harness.Send(host, 'GET', '/api/manifests')).body) as { id: string; channel?: string }[]
        assert.equal(all.find(m => m.id === '1.0.0')!.channel, 'early')
    })

    it('publish rejects an invalid channel', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1', channel: 'beta' })
        assert.equal(r.status, 400)
        assert.deepEqual(JSON.parse((await Harness.Send(host, 'GET', '/api/manifests')).body), [])
    })

    it('publish without a channel defaults to stable', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        const all = JSON.parse((await Harness.Send(host, 'GET', '/api/manifests')).body) as { channel?: string }[]
        assert.equal(all[0]!.channel, 'stable')
    })

    it('withdraw requires a non-empty reason', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        assert.equal((await Harness.Send(host, 'POST', '/api/manifests/1.0.0/withdrawn')).status, 400)
        assert.equal((await Harness.Send(host, 'POST', '/api/manifests/1.0.0/withdrawn', {})).status, 400)
        assert.equal((await Harness.Send(host, 'POST', '/api/manifests/1.0.0/withdrawn', { reason: '  ' })).status, 400)
        const all = JSON.parse((await Harness.Send(host, 'GET', '/api/manifests')).body) as { withdrawn?: boolean }[]
        assert.notEqual(all[0]!.withdrawn, true)
    })

    it('withdraw records the reason and the session actor, and restore clears it', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        const w = await Harness.Send(host, 'POST', '/api/manifests/1.0.0/withdrawn', { reason: 'bad build' })
        assert.equal(w.status, 200)
        const rec = JSON.parse(w.body) as { withdrawal?: { reason: string; actor: string } }
        assert.equal(rec.withdrawal!.reason, 'bad build')
        assert.equal(rec.withdrawal!.actor, 'op@example.com')
        const restored = await Harness.Send(host, 'DELETE', '/api/manifests/1.0.0/withdrawn')
        assert.equal(restored.status, 200)
        assert.equal((JSON.parse(restored.body) as { withdrawal?: unknown }).withdrawal, undefined)
    })

    it('a non-Full operator is still 403 on publish and withdraw', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        operator.Role = OperatorRole.ReadOnly
        assert.equal((await Harness.Send(host, 'POST', '/api/manifests', { version: '2.0.0', image: 'img:2' })).status, 403)
        assert.equal((await Harness.Send(host, 'POST', '/api/manifests/1.0.0/withdrawn', { reason: 'x' })).status, 403)
    })

    it('answers a withdrawn toggle for an unknown version with 404', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/manifests/9.9.9/withdrawn', { reason: 'r' })).status, 404)
    })

    it('no longer selects a target from the operator plane, and reports the rollout status', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '1.0.0' })
        const selected = await Harness.Send(host, 'POST', '/api/hives/local1/target', { version: '1.0.0' })
        assert.equal(selected.status, 404)
        assert.equal(deployments.TargetFor('local1'), undefined)
        const status = await Harness.Send(host, 'GET', '/api/hives/local1/rollout')
        assert.equal(status.status, 200)
        assert.deepEqual(JSON.parse(status.body), { environments: [] })
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

    it('challenges an unauthenticated GET /api/manifests with 401', async () =>
    {
        assert.equal((await Harness.Send(host, 'GET', '/api/manifests', undefined, false)).status, 401)
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
            ['GET', '/api/hives/local1/rollout', undefined],
            ['POST', '/api/hives/local1/rollout-registration', undefined]
        ]
        for (const [method, path, body] of calls)
        {
            assert.equal((await Harness.Send(host, method, path, body, false)).status, 401, method + ' ' + path)
        }
    })

    it('maps an unknown manifest to 404, and a duplicate publish to 409', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '2.0.0', image: 'img:2' })
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants/t1/gating', { version: '9.9.9' })).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/manifests', { version: '2.0.0', image: 'img:2' })).status, 409)
    })

    it('rejects a malformed publish body with 400', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/manifests', { version: '3.0.0' })).status, 400)
    })
})
