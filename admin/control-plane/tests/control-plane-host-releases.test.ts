import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
import { Channel } from '../channel.js'
import { ReleaseState, type ManifestRecord } from '../manifest-record.js'
import { OciRegistryClient, type OciRequestInit } from '../oci-registry-client.js'
import { ReleaseCatalog, type ReleaseRefreshResult } from '../release/release-catalog.js'
import { ReleaseRefresher, type IReleaseRefreshSource } from '../release/release-refresher.js'
import { ReleaseTrustKeys } from '../release/release-trust-keys.js'
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

    public async ChangeOwnPassword(_p: string, _c: string, _n: string): Promise<null> { return null }
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

/** A catalogue stand-in that answers a fixed result (or throws a given error) and counts its calls. */
class FakeCatalog implements IReleaseRefreshSource
{
    public static readonly Result: ReleaseRefreshResult = { imported: ['4.0.0'], rejected: ['4.1.0'], unchanged: 2, shadowed: ['1.0.0'] }

    public Calls = 0

    public constructor(private readonly failure?: Error)
    {
    }

    public async Refresh(): Promise<ReleaseRefreshResult>
    {
        this.Calls++
        if (this.failure !== undefined)
        {
            throw this.failure
        }
        return FakeCatalog.Result
    }
}

class Fx
{
    public static readonly RefreshPath = '/api/releases/refresh'
    public static readonly ManifestsPath = '/api/manifests'
    public static readonly GatingPath = '/api/tenants/t1/gating'
    public static readonly Post = 'POST'
    public static readonly Get = 'GET'
    public static readonly NotConfigured = 'The release registry is not configured.'
    public static readonly Unavailable = 'The release registry is unreachable or refused the credential'
    public static readonly RefreshFailed = 'The release refresh failed.'
    public static readonly RejectedPrefix = 'Release rejected on import: '
    public static readonly Token = 'ghp_SECRET_release_token_value'
    public static readonly InnerPath = '/secret/data/manifests.json'
    public static readonly Namespace = 'pragmatic-tech-ai'
    public static readonly RegistryUrl = 'https://ghcr.example'
    public static readonly TrustDir = join(import.meta.dirname, '..', '..', '..', 'release-keys')
    public static readonly Version = '4.0.0'
    public static readonly Digest = 'sha256:' + 'c'.repeat(64)
    public static readonly BuiltAt = '2026-11-12T10:00:00.000Z'

    public static Verified(version: string): ManifestRecord
    {
        return {
            id: version,
            image: 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server@' + Fx.Digest,
            digest: Fx.Digest,
            signed: true,
            channel: Channel.Stable,
            publishedAt: Fx.BuiltAt,
            release: { state: ReleaseState.Verified, builtAt: Fx.BuiltAt, signingKeyId: 'release-2026-11' },
        }
    }

    public static Rejected(version: string): ManifestRecord
    {
        return { id: version, image: '', signed: false, channel: Channel.Stable, publishedAt: Fx.BuiltAt, release: { state: ReleaseState.Rejected, rejectedReason: 'image digest mismatch: pragmatic-env-gateway' } }
    }

    public static Send(host: ControlPlaneHost, method: string, path: string, body?: unknown): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json', cookie: 'cp_session=' + FakeOperator.Token }
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

    /** Runs body with console.error captured; answers every logged line (its arguments joined). */
    public static async CapturingErrors(body: () => Promise<void>): Promise<string[]>
    {
        const lines: string[] = []
        const original = console.error
        console.error = (...args: unknown[]) => { lines.push(args.map(a => String(a)).join(' ')) }
        try
        {
            await body()
        }
        finally
        {
            console.error = original
        }
        return lines
    }
}

/** A directory with one tenant and hive, a real deployment registry, and the host started over them. */
class HostFixture
{
    public readonly Operator = new FakeOperator()
    private host: ControlPlaneHost | undefined

    private constructor(private readonly parent: string, private readonly root: string, private readonly directory: PlatformDirectory, public readonly Deployments: PlatformDeploymentRegistry)
    {
    }

    public static async Create(): Promise<HostFixture>
    {
        const parent = mkdtempSync(join(tmpdir(), 'cp-releases-'))
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
        return new HostFixture(parent, root, directory, await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory()))
    }

    /** Starts the host with the given refresher (undefined: no registry configured). */
    public async Start(releases: ReleaseRefresher | undefined): Promise<ControlPlaneHost>
    {
        const h = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, this.root, this.Operator, false, this.directory, this.Deployments, new FakeProvisioning(this.directory).AsService(), RolloutFixture.Observations(this.parent),
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, releases)
        await h.Listen(0, '127.0.0.1')
        this.host = h
        return h
    }

    public async Dispose(): Promise<void>
    {
        await this.host?.Close()
        rmSync(this.parent, { recursive: true, force: true })
    }
}

describe('ControlPlaneHost release routes', () =>
{
    let fx: HostFixture

    beforeEach(async () =>
    {
        fx = await HostFixture.Create()
    })

    afterEach(async () =>
    {
        await fx.Dispose()
    })

    it('refreshes the catalogue for a Full operator and answers its result', async () =>
    {
        const catalog = new FakeCatalog()
        const h = await fx.Start(new ReleaseRefresher(catalog))
        const reply = await Fx.Send(h, Fx.Post, Fx.RefreshPath)
        assert.equal(reply.status, 200)
        assert.deepEqual(JSON.parse(reply.body), FakeCatalog.Result)
        assert.equal(catalog.Calls, 1)
    })

    it('refuses an Observer (ReadOnly) with 403 through the central gate and never refreshes', async () =>
    {
        const catalog = new FakeCatalog()
        const h = await fx.Start(new ReleaseRefresher(catalog))
        fx.Operator.Role = OperatorRole.ReadOnly
        const reply = await Fx.Send(h, Fx.Post, Fx.RefreshPath)
        assert.equal(reply.status, 403)
        assert.equal(catalog.Calls, 0)
    })

    it('answers 409 with a plain sentence when no release registry is configured', async () =>
    {
        const h = await fx.Start(undefined)
        const reply = await Fx.Send(h, Fx.Post, Fx.RefreshPath)
        assert.equal(reply.status, 409)
        assert.deepEqual(JSON.parse(reply.body), { error: Fx.NotConfigured })
    })

    it('answers 502 with the fixed sentence when the registry is unreachable, never echoing or logging the token', async () =>
    {
        // A lower layer whose failure text carries the token: the catalogue's fixed sentence must be all that reaches the body.
        const leaky = async (_url: string, _init: OciRequestInit): Promise<Response> =>
        {
            throw new Error('connect failed with bearer ' + Fx.Token)
        }
        const registry = new OciRegistryClient(Fx.RegistryUrl, leaky, { username: 'bot', token: Fx.Token })
        const catalog = new ReleaseCatalog(registry, Fx.Namespace, ReleaseTrustKeys.FromDirectory(Fx.TrustDir), fx.Deployments)
        const h = await fx.Start(new ReleaseRefresher(catalog))
        let reply: Reply = { status: 0, body: '' }
        const logged = await Fx.CapturingErrors(async () =>
        {
            reply = await Fx.Send(h, Fx.Post, Fx.RefreshPath)
        })
        assert.equal(reply.status, 502)
        assert.deepEqual(JSON.parse(reply.body), { error: Fx.Unavailable })
        assert.ok(!reply.body.includes(Fx.Token))
        assert.ok(!logged.join().includes(Fx.Token))
        assert.deepEqual(fx.Deployments.AllManifests(), [])
    })

    it('answers any other refresh failure with a plain 500 and logs only the error name', async () =>
    {
        const h = await fx.Start(new ReleaseRefresher(new FakeCatalog(new Error('write failed: ' + Fx.InnerPath))))
        let reply: Reply = { status: 0, body: '' }
        const logged = await Fx.CapturingErrors(async () =>
        {
            reply = await Fx.Send(h, Fx.Post, Fx.RefreshPath)
        })
        assert.equal(reply.status, 500)
        assert.deepEqual(JSON.parse(reply.body), { error: Fx.RefreshFailed })
        assert.equal(logged.length, 1)
        assert.ok(logged[0]!.endsWith('release refresh failed: Error'), logged[0])
        assert.ok(!logged.join().includes(Fx.InnerPath))
    })

    it('no longer publishes on POST /api/manifests (an unknown route), and stores nothing', async () =>
    {
        const h = await fx.Start(undefined)
        const reply = await Fx.Send(h, Fx.Post, Fx.ManifestsPath, { version: '1.0.0', image: 'img:1' })
        assert.equal(reply.status, 404)
        assert.deepEqual(fx.Deployments.AllManifests(), [])
    })

    it('lists an imported release on GET /api/manifests with its release provenance', async () =>
    {
        await fx.Deployments.ImportRelease(Fx.Verified(Fx.Version))
        const h = await fx.Start(undefined)
        const reply = await Fx.Send(h, Fx.Get, Fx.ManifestsPath)
        assert.equal(reply.status, 200)
        assert.deepEqual(JSON.parse(reply.body), [Fx.Verified(Fx.Version)])
    })

    it('answers gating a rejected release with 409 and the error sentence', async () =>
    {
        await fx.Deployments.ImportRelease(Fx.Rejected(Fx.Version))
        const h = await fx.Start(undefined)
        const reply = await Fx.Send(h, Fx.Post, Fx.GatingPath, { version: Fx.Version })
        assert.equal(reply.status, 409)
        assert.deepEqual(JSON.parse(reply.body), { error: Fx.RejectedPrefix + Fx.Version })
    })
})
