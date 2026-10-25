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

class Names
{
    public static readonly HiveId = 'local1'
    public static readonly SpacedHive = 'h 1'
    public static readonly PlainHive = 'h1'
    public static readonly OtherHive = 'other'
    public static readonly Tenant = 't1'
    public static readonly Secret = 'sekret'
    public static readonly WrongToken = 'wrong'
    public static readonly Version = '1.0.0'
    public static readonly Image = 'img:1'
    public static readonly Body = 'boom'
    public static readonly MalformedPayload = '{"unexpected":true}'
    public static readonly Loopback = '127.0.0.1'
    public static readonly HttpPrefix = 'http://127.0.0.1:'
    public static readonly DeadBase = 'http://127.0.0.1:1'
    public static readonly Utf8 = 'utf8'
    public static readonly MethodGet = 'GET'
    public static readonly MethodPost = 'POST'
    public static readonly BearerPrefix = 'Bearer '
    public static readonly AdoptPath = '/agent/hives/h%201/adopt'
    public static readonly StatusPath = '/agent/hives/h%201/status'
    public static readonly TempPrefix = 'http-rollout-'
    public static readonly Acme = 'acme'
    public static readonly AcmeName = 'Acme'
    public static readonly TenantName = 'T'
    public static readonly HiveName = 'L'
    public static readonly ClientsFile = 'clients.json'
    public static readonly TenantsFile = 'tenants.json'
    public static readonly HivesFile = 'hives.json'
    public static readonly Status204 = 204
    public static readonly Status500 = 500
    public static readonly Status200 = 200
}

/** A canned channel that records requests and answers a fixed status. */
class StubChannel
{
    public readonly Seen: Array<{ method: string; url: string; authorization: string | undefined; body: string }> = []
    private server: Server | undefined

    public constructor(private readonly status: number, private readonly payload: string = Names.Body)
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
                this.Seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body: Buffer.concat(chunks).toString(Names.Utf8) })
                res.writeHead(this.status)
                res.end(this.payload)
            })
        })
        this.server = server
        await new Promise<void>(r => server.listen(0, Names.Loopback, r))
        return Names.HttpPrefix + (server.address() as AddressInfo).port
    }

    public async Stop(): Promise<void>
    {
        this.server!.closeAllConnections()
        await new Promise<void>(r => this.server!.close(() => r()))
    }
}

describe('HttpRolloutClient against a real AgentChannelHost', () =>
{
    let host: AgentChannelHost
    let deployments: PlatformDeploymentRegistry
    let parent: string
    let client: HttpRolloutClient

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), Names.TempPrefix))
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, Names.ClientsFile)),
            new TenantRegistry(join(parent, Names.TenantsFile)),
            new HiveRegistry(join(parent, Names.HivesFile)),
            { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: Names.Acme, displayName: Names.AcmeName })
        await directory.CreateTenant({ id: Names.Tenant, clientId: Names.Acme, displayName: Names.TenantName })
        await directory.CreateHive({ id: Names.HiveId, tenantId: Names.Tenant, displayName: Names.HiveName, cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        const token = await deployments.RegisterHive(Names.HiveId)
        host = new AgentChannelHost(deployments)
        await host.Listen(0, Names.Loopback)
        client = new HttpRolloutClient(Names.HttpPrefix + host.Address().port, token, Names.HiveId)
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('lists adoptable versions, adopts one and reads the status', async () =>
    {
        await deployments.Publish(Names.Version, Names.Image)
        await deployments.Gate(Names.Tenant, Names.Version)
        assert.deepEqual((await client.ManifestsFor(Names.Tenant)).map(m => m.id), [Names.Version])
        await client.AdoptTarget(Names.HiveId, Names.Version)
        assert.equal((await client.StatusFor(Names.HiveId)).targetVersion, Names.Version)
    })

    it('throws RolloutAdoptionRefusedError for a non-gated version and records nothing', async () =>
    {
        await deployments.Publish(Names.Version, Names.Image)
        await assert.rejects(() => client.AdoptTarget(Names.HiveId, Names.Version), RolloutAdoptionRefusedError)
        assert.equal(deployments.TargetFor(Names.HiveId), undefined)
    })

    it('throws RolloutUnavailableError with a wrong token (401)', async () =>
    {
        const bad = new HttpRolloutClient(Names.HttpPrefix + host.Address().port, Names.WrongToken, Names.HiveId)
        await assert.rejects(() => bad.StatusFor(Names.HiveId), RolloutUnavailableError)
    })

    it('throws RolloutUnavailableError when the channel is unreachable', async () =>
    {
        const dead = new HttpRolloutClient(Names.DeadBase, 'x', Names.HiveId)
        await assert.rejects(() => dead.ManifestsFor(Names.Tenant), RolloutUnavailableError)
    })
})

describe('HttpRolloutClient request shape', () =>
{
    it('sends the bearer only in the Authorization header, to the right routes', async () =>
    {
        const stub = new StubChannel(Names.Status204)
        const base = await stub.Start()
        try
        {
            const c = new HttpRolloutClient(base, Names.Secret, Names.SpacedHive)
            await c.AdoptTarget(Names.SpacedHive, Names.Version)
            await assert.rejects(() => c.StatusFor(Names.SpacedHive))
            assert.equal(stub.Seen[0]!.method, Names.MethodPost)
            assert.equal(stub.Seen[0]!.url, Names.AdoptPath)
            assert.deepEqual(JSON.parse(stub.Seen[0]!.body), { version: Names.Version })
            assert.equal(stub.Seen[1]!.method, Names.MethodGet)
            assert.equal(stub.Seen[1]!.url, Names.StatusPath)
            for (const s of stub.Seen)
            {
                assert.equal(s.authorization, Names.BearerPrefix + Names.Secret)
                assert.ok(!s.url.includes(Names.Secret))
            }
        }
        finally
        {
            await stub.Stop()
        }
    })

    it('maps a 5xx to RolloutUnavailableError without leaking the body or token', async () =>
    {
        const stub = new StubChannel(Names.Status500)
        const base = await stub.Start()
        try
        {
            const c = new HttpRolloutClient(base, Names.Secret, Names.PlainHive)
            await assert.rejects(() => c.StatusFor(Names.PlainHive), (e: Error) => e instanceof RolloutUnavailableError && !e.message.includes(Names.Body) && !e.message.includes(Names.Secret))
        }
        finally
        {
            await stub.Stop()
        }
    })

    it('refuses a call for a different hive than the one it is bound to', async () =>
    {
        const stub = new StubChannel(Names.Status204)
        const base = await stub.Start()
        try
        {
            const c = new HttpRolloutClient(base, Names.Secret, Names.PlainHive)
            await assert.rejects(() => c.AdoptTarget(Names.OtherHive, Names.Version))
            await assert.rejects(() => c.StatusFor(Names.OtherHive))
            assert.equal(stub.Seen.length, 0)
        }
        finally
        {
            await stub.Stop()
        }
    })

    it('throws RolloutUnavailableError on a malformed 200 payload', async () =>
    {
        const stub = new StubChannel(Names.Status200, Names.MalformedPayload)
        const base = await stub.Start()
        try
        {
            const c = new HttpRolloutClient(base, Names.Secret, Names.PlainHive)
            await assert.rejects(() => c.ManifestsFor(Names.Tenant), RolloutUnavailableError)
            await assert.rejects(() => c.StatusFor(Names.PlainHive), RolloutUnavailableError)
        }
        finally
        {
            await stub.Stop()
        }
    })
})
