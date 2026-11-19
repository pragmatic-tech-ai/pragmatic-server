import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AgentChannelOperation } from '../agent-channel-backend.js'
import type { DiscoveryReply, IDesktopDiscoveryBackend } from '../desktop-discovery-backend.js'
import { InternalApiCredential } from '../internal-api-credential.js'
import { InternalApiHost } from '../internal-api-host.js'
import { InternalApiRoutes } from '../internal-api-routes.js'
import { LocalAgentChannelBackend } from '../local-agent-channel-backend.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { RolloutFixture } from './rollout-fixture.js'

type Reply = { status: number; body: unknown }

class FixedDiscovery implements IDesktopDiscoveryBackend
{
    public readonly Asked: string[] = []

    public async Discover(email: string): Promise<DiscoveryReply>
    {
        this.Asked.push(email)
        return { Status: 200, Body: { tenants: [{ id: 'acme', displayName: 'Acme', consoleUrl: 'https://c.example' }] } }
    }
}

class InternalFixture
{
    public static readonly HiveId = 'local1'

    public static Send(host: InternalApiHost, method: string, path: string, bearer: string | undefined, body?: unknown): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (bearer !== undefined)
        {
            headers.authorization = 'Bearer ' + bearer
        }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () =>
                {
                    const text = Buffer.concat(chunks).toString('utf8')
                    resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? undefined : JSON.parse(text) })
                })
            })
            req.on('error', reject)
            req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
        })
    }
}

describe('InternalApiHost', () =>
{
    let parent: string
    let deployments: PlatformDeploymentRegistry
    let token: string
    let credential: InternalApiCredential
    let discovery: FixedDiscovery
    let host: InternalApiHost

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'internal-api-'))
        const directory = new PlatformDirectory(new ClientRegistry(join(parent, 'clients.json')), new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')), { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'acme', displayName: 'Acme' })
        await directory.CreateTenant({ id: 't1', clientId: 'acme', displayName: 'T' })
        await directory.CreateHive({ id: InternalFixture.HiveId, tenantId: 't1', displayName: 'L', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        token = await deployments.RegisterHive(InternalFixture.HiveId)
        writeFileSync(join(parent, 'secret'), 'k'.repeat(40))
        credential = InternalApiCredential.FromFile(join(parent, 'secret'))
        discovery = new FixedDiscovery()
        host = new InternalApiHost(credential, new LocalAgentChannelBackend(deployments), discovery)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('refuses a missing or wrong internal bearer with 401 on every POST route, and runs nothing', async () =>
    {
        for (const path of [InternalApiRoutes.Agent, InternalApiRoutes.Discover])
        {
            for (const bearer of [undefined, 'wrong', credential.Bearer() + 'x'])
            {
                const reply = await InternalFixture.Send(host, 'POST', path, bearer, { Operation: AgentChannelOperation.Target, HiveId: InternalFixture.HiveId, Token: token, email: 'a@b.c' })
                assert.equal(reply.status, 401)
                assert.deepEqual(reply.body, { error: 'unauthorized' })
            }
        }
        assert.deepEqual(discovery.Asked, [])
    })

    it('forwards an agent-channel request and answers the backend\'s reply, inner status included', async () =>
    {
        await deployments.Publish('1.0.0', 'img:1')
        await deployments.Gate('t1', '1.0.0')
        await deployments.SelectTarget(InternalFixture.HiveId, '1.0.0')
        const ok = await InternalFixture.Send(host, 'POST', InternalApiRoutes.Agent, credential.Bearer(), { Operation: AgentChannelOperation.Target, HiveId: InternalFixture.HiveId, Token: token })
        assert.deepEqual(ok, { status: 200, body: { Status: 200, Body: { version: '1.0.0', image: 'img:1' } } })
        const badToken = await InternalFixture.Send(host, 'POST', InternalApiRoutes.Agent, credential.Bearer(), { Operation: AgentChannelOperation.Target, HiveId: InternalFixture.HiveId, Token: 'wrong' })
        assert.deepEqual(badToken, { status: 200, body: { Status: 401, Body: { error: 'Unauthorized' } } })
    })

    it('forwards discovery to the discovery backend', async () =>
    {
        const reply = await InternalFixture.Send(host, 'POST', InternalApiRoutes.Discover, credential.Bearer(), { email: 'ann@acme.test' })
        assert.deepEqual(reply, { status: 200, body: { Status: 200, Body: { tenants: [{ id: 'acme', displayName: 'Acme', consoleUrl: 'https://c.example' }] } } })
        assert.deepEqual(discovery.Asked, ['ann@acme.test'])
    })

    it('answers 400 for malformed JSON or an invalid request shape', async () =>
    {
        assert.equal((await InternalFixture.Send(host, 'POST', InternalApiRoutes.Agent, credential.Bearer(), '{not json')).status, 400)
        assert.equal((await InternalFixture.Send(host, 'POST', InternalApiRoutes.Agent, credential.Bearer(), { Operation: 'rm -rf', HiveId: 'x', Token: 't' })).status, 400)
        assert.equal((await InternalFixture.Send(host, 'POST', InternalApiRoutes.Discover, credential.Bearer(), { email: 42 })).status, 400)
    })

    it('serves healthz without auth and 404 for anything else', async () =>
    {
        assert.deepEqual(await InternalFixture.Send(host, 'GET', InternalApiRoutes.Healthz, undefined), { status: 200, body: { ok: true } })
        assert.equal((await InternalFixture.Send(host, 'GET', '/internal/v1/other', credential.Bearer())).status, 404)
        assert.equal((await InternalFixture.Send(host, 'GET', InternalApiRoutes.Agent, credential.Bearer())).status, 404)
    })
})
