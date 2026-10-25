import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
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
import { HttpRolloutClient } from '../tenant-api/http-rollout-client.js'
import { RolloutAdoptionRefusedError, RolloutUnavailableError } from '../tenant-api/rollout-client.js'
import { RolloutFixture } from './rollout-fixture.js'

/** A canned channel that records requests and answers a fixed status. */
class StubChannel
{
    public readonly Seen: Array<{ method: string; url: string; authorization: string | undefined; body: string }> = []
    private server: Server | undefined

    public constructor(private readonly status: number)
    {
    }

    public async Start(): Promise<string>
    {
        const server = createServer((req: IncomingMessage, res: ServerResponse) =>
        {
            const chunks: Buffer[] = []
            req.on('data', c => chunks.push(c as Buffer))
            req.on('end', () =>
            {
                this.Seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
                res.writeHead(this.status)
                res.end('boom')
            })
        })
        this.server = server
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
        return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    }

    public async Stop(): Promise<void>
    {
        this.server!.closeAllConnections()
        await new Promise<void>(r => this.server!.close(() => r()))
    }
}

describe('HttpRolloutClient against a real AgentChannelHost', () =>
{
    const HiveId = 'local1'
    let host: AgentChannelHost
    let deployments: PlatformDeploymentRegistry
    let parent: string
    let client: HttpRolloutClient

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'http-rollout-'))
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'acme', displayName: 'Acme' })
        await directory.CreateTenant({ id: 't1', clientId: 'acme', displayName: 'T' })
        await directory.CreateHive({ id: HiveId, tenantId: 't1', displayName: 'L', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        const token = await deployments.RegisterHive(HiveId)
        host = new AgentChannelHost(deployments)
        await host.Listen(0, '127.0.0.1')
        client = new HttpRolloutClient('http://127.0.0.1:' + host.Address().port, token, HiveId)
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('lists adoptable versions, adopts one and reads the status', async () =>
    {
        await deployments.Publish('1.0.0', 'img:1')
        await deployments.Gate('t1', '1.0.0')
        assert.deepEqual((await client.ManifestsFor('t1')).map(m => m.id), ['1.0.0'])
        await client.AdoptTarget(HiveId, '1.0.0')
        assert.equal((await client.StatusFor(HiveId)).targetVersion, '1.0.0')
    })

    it('throws RolloutAdoptionRefusedError for a non-gated version and records nothing', async () =>
    {
        await deployments.Publish('1.0.0', 'img:1')
        await assert.rejects(() => client.AdoptTarget(HiveId, '1.0.0'), RolloutAdoptionRefusedError)
        assert.equal(deployments.TargetFor(HiveId), undefined)
    })

    it('throws RolloutUnavailableError with a wrong token (401)', async () =>
    {
        const bad = new HttpRolloutClient('http://127.0.0.1:' + host.Address().port, 'wrong', HiveId)
        await assert.rejects(() => bad.StatusFor(HiveId), RolloutUnavailableError)
    })

    it('throws RolloutUnavailableError when the channel is unreachable', async () =>
    {
        const dead = new HttpRolloutClient('http://127.0.0.1:1', 'x', HiveId)
        await assert.rejects(() => dead.ManifestsFor('t1'), RolloutUnavailableError)
    })
})

describe('HttpRolloutClient request shape', () =>
{
    it('sends the bearer only in the Authorization header, to the right routes', async () =>
    {
        const stub = new StubChannel(204)
        const base = await stub.Start()
        try
        {
            const c = new HttpRolloutClient(base, 'sekret', 'h 1')
            await c.AdoptTarget('h 1', '1.0.0')
            await assert.rejects(() => c.StatusFor('h 1'))
            assert.equal(stub.Seen[0]!.method, 'POST')
            assert.equal(stub.Seen[0]!.url, '/agent/hives/h%201/adopt')
            assert.deepEqual(JSON.parse(stub.Seen[0]!.body), { version: '1.0.0' })
            assert.equal(stub.Seen[1]!.method, 'GET')
            assert.equal(stub.Seen[1]!.url, '/agent/hives/h%201/status')
            for (const s of stub.Seen)
            {
                assert.equal(s.authorization, 'Bearer sekret')
                assert.ok(!s.url.includes('sekret'))
            }
        }
        finally
        {
            await stub.Stop()
        }
    })

    it('maps a 5xx to RolloutUnavailableError without leaking the body or token', async () =>
    {
        const stub = new StubChannel(500)
        const base = await stub.Start()
        try
        {
            const c = new HttpRolloutClient(base, 'sekret', 'h1')
            await assert.rejects(() => c.StatusFor('h1'), (e: Error) => e instanceof RolloutUnavailableError && !e.message.includes('boom') && !e.message.includes('sekret'))
        }
        finally
        {
            await stub.Stop()
        }
    })
})
