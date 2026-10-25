import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AgentChannelHost } from '../agent-channel-host.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { RolloutFixture } from './rollout-fixture.js'

type Reply = { status: number; body: string }

class Harness
{
    public static Send(host: AgentChannelHost, method: string, path: string, authorization?: string, body?: unknown): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (authorization !== undefined)
        {
            headers.authorization = authorization
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
            req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
        })
    }
}

describe('AgentChannelHost', () =>
{
    const TargetPath = '/agent/hives/local1/target'
    const SnapshotPath = '/agent/hives/local1/snapshot'
    const Health = { environmentName: 'prod', ready: true, runningImage: 'img:1', detail: 'ok' }
    let host: AgentChannelHost
    let deployments: PlatformDeploymentRegistry
    let parent: string
    let token: string

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'agent-channel-'))
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'acme', displayName: 'Acme' })
        await directory.CreateTenant({ id: 't1', clientId: 'acme', displayName: 'T' })
        await directory.CreateHive({ id: 'local1', tenantId: 't1', displayName: 'L', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        token = await deployments.RegisterHive('local1')
        host = new AgentChannelHost(deployments)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('serves the selected target to a correct bearer, 404 when none is selected', async () =>
    {
        assert.equal((await Harness.Send(host, 'GET', TargetPath, 'Bearer ' + token)).status, 404)
        await deployments.Publish('1.0.0', 'img:1')
        await deployments.Gate('t1', '1.0.0')
        await deployments.SelectTarget('local1', '1.0.0')
        const reply = await Harness.Send(host, 'GET', TargetPath, 'Bearer ' + token)
        assert.equal(reply.status, 200)
        assert.deepEqual(JSON.parse(reply.body), { version: '1.0.0', image: 'img:1' })
    })

    it('records a snapshot for a correct bearer and answers 204', async () =>
    {
        const reply = await Harness.Send(host, 'POST', SnapshotPath, 'Bearer ' + token, { environments: [Health] })
        assert.equal(reply.status, 204)
        assert.deepEqual(deployments.StatusFor('local1').environments.map(e => e.environmentName), ['prod'])
    })

    it('rejects a missing, wrong or malformed bearer with 401 and writes nothing', async () =>
    {
        const replies = [
            await Harness.Send(host, 'POST', SnapshotPath, undefined, { environments: [Health] }),
            await Harness.Send(host, 'POST', SnapshotPath, 'Bearer wrong-token-value', { environments: [Health] }),
            await Harness.Send(host, 'POST', SnapshotPath, 'Basic ' + token, { environments: [Health] }),
            await Harness.Send(host, 'GET', TargetPath),
            await Harness.Send(host, 'GET', TargetPath, 'Bearer wrong-token-value')
        ]
        for (const r of replies)
        {
            assert.equal(r.status, 401)
            assert.ok(!r.body.includes(token))
            assert.ok(!r.body.includes('wrong-token-value'))
        }
        assert.equal(deployments.StatusFor('local1').environments.length, 0)
    })

    it('rejects a malformed snapshot body with 400 and writes nothing', async () =>
    {
        const bodies: unknown[] = [
            '{not json',
            [],
            {},
            { environments: 'x' },
            { environments: [{ ...Health, environmentName: '' }] },
            { environments: [{ ...Health, ready: 'yes' }] },
            { environments: [{ ...Health, runningImage: 5 }] },
            { environments: [{ ...Health, detail: undefined }] },
            { environments: [Health, null] }
        ]
        for (const b of bodies)
        {
            assert.equal((await Harness.Send(host, 'POST', SnapshotPath, 'Bearer ' + token, b)).status, 400)
        }
        assert.equal(deployments.StatusFor('local1').environments.length, 0)
    })

    it('accepts an absent runningImage', async () =>
    {
        const h = { environmentName: 'prod', ready: false, detail: 'pending' }
        assert.equal((await Harness.Send(host, 'POST', SnapshotPath, 'Bearer ' + token, { environments: [h] })).status, 204)
    })

    it('answers 404 for any other path or method', async () =>
    {
        const auth = 'Bearer ' + token
        assert.equal((await Harness.Send(host, 'GET', '/', auth)).status, 404)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/local1/agent/target', auth)).status, 404)
        assert.equal((await Harness.Send(host, 'POST', TargetPath, auth, {})).status, 404)
        assert.equal((await Harness.Send(host, 'GET', SnapshotPath, auth)).status, 404)
        assert.equal((await Harness.Send(host, 'DELETE', SnapshotPath, auth)).status, 404)
        assert.equal((await Harness.Send(host, 'GET', '/agent/hives/local1/other', auth)).status, 404)
    })
})
