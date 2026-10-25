import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { PlaneHttp } from '../plane-http.js'
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
    public static readonly ContentTypeHeader = 'content-type'
    public static readonly JsonType = 'application/json'
    public static readonly AuthorizationHeader = 'authorization'
    public static readonly Utf8 = 'utf8'
    public static readonly BearerPrefix = 'Bearer '
    public static readonly BasicPrefix = 'Basic '
    public static readonly MethodDelete = 'DELETE'
    public static readonly HiveId = 'local1'
    public static readonly EnvName = 'prod'

    public static Send(host: AgentChannelHost, method: string, path: string, authorization?: string, body?: unknown): Promise<Reply>
    {
        const headers: Record<string, string> = { [Harness.ContentTypeHeader]: Harness.JsonType }
        if (authorization !== undefined)
        {
            headers[Harness.AuthorizationHeader] = authorization
        }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(Harness.Utf8) }))
            })
            req.on('error', reject)
            req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
        })
    }
}

describe('AgentChannelHost', () =>
{
    const WrongToken = 'wrong-token-value'
    const TargetPath = '/agent/hives/' + Harness.HiveId + '/target'
    const SnapshotPath = '/agent/hives/' + Harness.HiveId + '/snapshot'
    const OtherPath = '/agent/hives/' + Harness.HiveId + '/other'
    const LegacyPath = '/api/hives/' + Harness.HiveId + '/agent/target'
    const UnregisteredPath = '/agent/hives/ghost/snapshot'
    const BadEncodingPath = '/agent/hives/%E0%A4%A/target'
    const Health = { environmentName: Harness.EnvName, ready: true, runningImage: 'img:1', detail: 'ok' }
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
        await directory.CreateHive({ id: Harness.HiveId, tenantId: 't1', displayName: 'L', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        token = await deployments.RegisterHive(Harness.HiveId)
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
        assert.equal((await Harness.Send(host, PlaneHttp.MethodGet, TargetPath, Harness.BearerPrefix + token)).status, 404)
        await deployments.Publish('1.0.0', 'img:1')
        await deployments.Gate('t1', '1.0.0')
        await deployments.SelectTarget(Harness.HiveId, '1.0.0')
        const reply = await Harness.Send(host, PlaneHttp.MethodGet, TargetPath, Harness.BearerPrefix + token)
        assert.equal(reply.status, 200)
        assert.deepEqual(JSON.parse(reply.body), { version: '1.0.0', image: 'img:1' })
    })

    it('records a snapshot for a correct bearer and answers 204', async () =>
    {
        const reply = await Harness.Send(host, PlaneHttp.MethodPost, SnapshotPath, Harness.BearerPrefix + token, { environments: [Health] })
        assert.equal(reply.status, 204)
        assert.deepEqual(deployments.StatusFor(Harness.HiveId).environments.map(e => e.environmentName), [Harness.EnvName])
    })

    it('rejects a missing, wrong or malformed bearer with 401 and writes nothing', async () =>
    {
        const replies = [
            await Harness.Send(host, PlaneHttp.MethodPost, SnapshotPath, undefined, { environments: [Health] }),
            await Harness.Send(host, PlaneHttp.MethodPost, SnapshotPath, Harness.BearerPrefix + WrongToken, { environments: [Health] }),
            await Harness.Send(host, PlaneHttp.MethodPost, SnapshotPath, Harness.BasicPrefix + token, { environments: [Health] }),
            await Harness.Send(host, PlaneHttp.MethodGet, TargetPath),
            await Harness.Send(host, PlaneHttp.MethodGet, TargetPath, Harness.BearerPrefix + WrongToken)
        ]
        for (const r of replies)
        {
            assert.equal(r.status, 401)
            assert.ok(!r.body.includes(token))
            assert.ok(!r.body.includes(WrongToken))
        }
        assert.equal(deployments.StatusFor(Harness.HiveId).environments.length, 0)
    })

    it('rejects a malformed snapshot body with 400 and writes nothing', async () =>
    {
        const bodies: unknown[] = [
            '{not json',
            'null',
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
            assert.equal((await Harness.Send(host, PlaneHttp.MethodPost, SnapshotPath, Harness.BearerPrefix + token, b)).status, 400)
        }
        assert.equal(deployments.StatusFor(Harness.HiveId).environments.length, 0)
    })

    it('accepts an absent runningImage', async () =>
    {
        const h = { environmentName: Harness.EnvName, ready: false, detail: 'pending' }
        assert.equal((await Harness.Send(host, PlaneHttp.MethodPost, SnapshotPath, Harness.BearerPrefix + token, { environments: [h] })).status, 204)
    })

    it('answers 404 for any other path or method', async () =>
    {
        const auth = Harness.BearerPrefix + token
        assert.equal((await Harness.Send(host, PlaneHttp.MethodGet, '/', auth)).status, 404)
        assert.equal((await Harness.Send(host, PlaneHttp.MethodGet, LegacyPath, auth)).status, 404)
        assert.equal((await Harness.Send(host, PlaneHttp.MethodPost, TargetPath, auth, {})).status, 404)
        assert.equal((await Harness.Send(host, PlaneHttp.MethodGet, SnapshotPath, auth)).status, 404)
        assert.equal((await Harness.Send(host, Harness.MethodDelete, SnapshotPath, auth)).status, 404)
        assert.equal((await Harness.Send(host, PlaneHttp.MethodGet, OtherPath, auth)).status, 404)
    })

    it('answers 401 for a bearer sent to an unregistered hive, writes nothing and logs nothing', async () =>
    {
        const logged: unknown[][] = []
        const original = console.error
        console.error = (...a: unknown[]) => { logged.push(a) }
        try
        {
            const reply = await Harness.Send(host, PlaneHttp.MethodPost, UnregisteredPath, Harness.BearerPrefix + token, { environments: [Health] })
            assert.equal(reply.status, 401)
            assert.ok(!reply.body.includes(token))
            assert.ok(!reply.body.includes('ghost'))
        }
        finally
        {
            console.error = original
        }
        assert.equal(logged.length, 0)
        assert.equal(deployments.StatusFor(Harness.HiveId).environments.length, 0)
    })

    it('answers 413 for an oversized body and writes nothing', async () =>
    {
        const big = { environments: [{ ...Health, detail: 'x'.repeat(1100000) }] }
        const reply = await Harness.Send(host, PlaneHttp.MethodPost, SnapshotPath, Harness.BearerPrefix + token, big)
        assert.equal(reply.status, 413)
        assert.ok(!reply.body.includes(token))
        assert.equal(deployments.StatusFor(Harness.HiveId).environments.length, 0)
    })

    it('answers 400 for an undecodable hive id and writes nothing', async () =>
    {
        const reply = await Harness.Send(host, PlaneHttp.MethodGet, BadEncodingPath, Harness.BearerPrefix + token)
        assert.equal(reply.status, 400)
        assert.equal(deployments.StatusFor(Harness.HiveId).environments.length, 0)
    })
})
