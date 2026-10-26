import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { EnvironmentPlacement } from '../environment-placement.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import type { IKubectl } from '../kubectl.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'
import { InProcessRolloutClient } from '../tenant-api/in-process-rollout-client.js'
import { RolloutFixture } from './rollout-fixture.js'
import { TenantApiEndpoint, TenantEnvAction } from '../tenant-api/tenant-api-endpoint.js'
import type { IEnvironmentService } from '../control-plane-host.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

/** Records what the endpoint wrote so a test can assert on status and JSON body without a real socket. */
class ResRecorder
{
    public status = 0
    public body = ''
    public headersSent = false
    public readonly headers: Record<string, string | number | string[]> = {}

    public setHeader(name: string, value: string | number | string[]): void
    {
        this.headers[name] = value
    }

    public writeHead(status: number, headers?: Record<string, string | number | string[]>): this
    {
        this.status = status
        if (headers !== undefined)
        {
            Object.assign(this.headers, headers)
        }
        this.headersSent = true
        return this
    }

    public end(body?: string): void
    {
        if (body !== undefined)
        {
            this.body = body
        }
    }

    public Json(): unknown
    {
        return JSON.parse(this.body)
    }
}

/** A fake environment service whose lifecycle methods record their calls and flip status, so a test can prove which action ran (and that cross-tenant actions never do). */
class FakeService
{
    public readonly Calls: Array<{ action: string; name: string }> = []

    public constructor(private readonly records: readonly EnvironmentRecord[])
    {
    }

    public List(): readonly EnvironmentRecord[]
    {
        return this.records
    }

    public async ListReconciled(): Promise<readonly EnvironmentRecord[]>
    {
        return this.records
    }

    public async Start(name: string): Promise<EnvironmentRecord>
    {
        this.Calls.push({ action: TenantEnvAction.Start, name })
        return this.Shaped(name, EnvStatus.Running)
    }

    public async Stop(name: string): Promise<EnvironmentRecord>
    {
        this.Calls.push({ action: TenantEnvAction.Stop, name })
        return this.Shaped(name, EnvStatus.Stopped)
    }

    public async Restart(name: string): Promise<EnvironmentRecord>
    {
        this.Calls.push({ action: TenantEnvAction.Restart, name })
        return this.Shaped(name, EnvStatus.Running)
    }

    private Shaped(name: string, status: EnvStatus): EnvironmentRecord
    {
        return { ...this.records.find(r => r.name === name)!, status }
    }
}

/** Records every SelectTarget call then delegates to the real registry, so a test can assert the exact arguments (or that it was never reached). */
class RecordingDeployments extends InProcessRolloutClient
{
    public readonly Targets: Array<{ hiveId: string; version: string }> = []

    public override async AdoptTarget(hiveId: string, version: string): Promise<void>
    {
        this.Targets.push({ hiveId, version })
        await super.AdoptTarget(hiveId, version)
    }
}

class FakeOrchestrator implements IHiveOrchestrator
{
    public readonly Kubectl = undefined as unknown as IKubectl
    public async Apply(_w: EnvironmentWorkload): Promise<void>
    {
    }

    public async WaitHealthy(_w: EnvironmentWorkload): Promise<void>
    {
    }

    public async Health(w: EnvironmentWorkload): Promise<WorkloadHealth>
    {
        return { ready: true, runningImage: 'img:' + w.environmentName, detail: 'ok ' + w.hiveId }
    }

    public async Roll(_w: EnvironmentWorkload, _image: string): Promise<void>
    {
    }

    public async Scale(_w: EnvironmentWorkload, _replicas: number): Promise<void>
    {
    }

    public async Teardown(_w: EnvironmentWorkload): Promise<void>
    {
    }
}

class FakeFactory extends HiveOrchestratorFactory
{
    public override For(hive: HiveRecord): IHiveOrchestrator
    {
        if (hive.cluster.backend !== HiveBackend.Local)
        {
            throw new UnsupportedBackendError(hive.cluster.backend, hive.cluster.mode)
        }
        return new FakeOrchestrator()
    }
}

class Fixtures
{
    public static Env(name: string, hiveId: string | undefined, tenantId: string | undefined): EnvironmentRecord
    {
        return {
            name, type: EnvType.Development, template: Template.DevBlank, environmentId: 'eid-' + name, tenantId, hiveId, hostPort: 8101,
            containerName: 'c-' + name, volumeName: 'v-' + name, bundleDir: '/b/' + name, createdAt: '2026-01-01T00:00:00Z', status: EnvStatus.Running
        }
    }

    public static Session(tenantId: string): TenantSession
    {
        return { id: 'sess-' + tenantId, tenantId, principalId: 'p-' + tenantId, expiresAt: '2099-01-01T00:00:00Z' }
    }

    /** A POST request with no body (env lifecycle routes read none). */
    public static Post(): IncomingMessage
    {
        return { method: 'POST' } as unknown as IncomingMessage
    }

    /** A POST request carrying a JSON body as a real readable stream (the target route reads it). */
    public static PostJson(body: unknown): IncomingMessage
    {
        const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage & { method?: string }
        stream.method = 'POST'
        return stream
    }
}

describe('TenantApiEndpoint mutation routes', () =>
{
    const TenantA = 't-a'
    const TenantB = 't-b'
    let parent: string
    let directory: PlatformDirectory
    let deployments: RecordingDeployments
    let service: FakeService
    let endpoint: TenantApiEndpoint

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'tenant-api-mutate-'))
        const hives = new HiveRegistry(join(parent, 'hives.json'))
        directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            hives,
            { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'acme-a', displayName: 'Acme A' })
        await directory.CreateClient({ id: 'acme-b', displayName: 'Acme B' })
        await directory.CreateTenant({ id: TenantA, clientId: 'acme-a', displayName: 'Tenant A' })
        await directory.CreateTenant({ id: TenantB, clientId: 'acme-b', displayName: 'Tenant B' })
        await directory.CreateHive({ id: 'hive-a', tenantId: TenantA, displayName: 'Hive A', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach } })
        await directory.CreateHive({ id: 'hive-b', tenantId: TenantB, displayName: 'Hive B', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        const records = [
            Fixtures.Env('a-env', 'hive-a', TenantA),
            Fixtures.Env('b-env', 'hive-b', TenantB),
            Fixtures.Env('unbound', undefined, undefined),
        ]
        service = new FakeService(records)
        const orchestrators = new FakeFactory()
        const real = await RolloutFixture.Create(parent, directory, orchestrators)
        await real.Publish('v1', 'registry/img:1')
        await real.Publish('v2', 'registry/img:2')
        await real.Gate(TenantA, 'v1')
        await real.Gate(TenantB, 'v2')
        deployments = new RecordingDeployments(real)
        endpoint = new TenantApiEndpoint(
            service as unknown as IEnvironmentService,
            directory,
            deployments,
            orchestrators,
            new EnvironmentPlacement(directory))
    })

    afterEach(() =>
    {
        rmSync(parent, { recursive: true, force: true })
    })

    async function Handle(req: IncomingMessage, path: string, session: TenantSession): Promise<ResRecorder>
    {
        const res = new ResRecorder()
        const handled = await endpoint.Handle(req, res as unknown as ServerResponse, path, session)
        assert.equal(handled, true)
        return res
    }

    it('rolls the tenant\'s own hive to a gated version: 204 and SelectTarget is called with (hive, version)', async () =>
    {
        const res = await Handle(Fixtures.PostJson({ version: 'v1' }), '/tenant-api/hives/hive-a/target', Fixtures.Session(TenantA))
        assert.equal(res.status, 204)
        assert.equal(res.body, '')
        assert.deepEqual(deployments.Targets, [{ hiveId: 'hive-a', version: 'v1' }])
    })

    it('404s a roll against another tenant\'s hive and never calls SelectTarget', async () =>
    {
        const res = await Handle(Fixtures.PostJson({ version: 'v2' }), '/tenant-api/hives/hive-b/target', Fixtures.Session(TenantA))
        assert.equal(res.status, 404)
        assert.deepEqual(deployments.Targets, [])
    })

    it('404s a roll against an unknown hive and never calls SelectTarget', async () =>
    {
        const res = await Handle(Fixtures.PostJson({ version: 'v1' }), '/tenant-api/hives/nope/target', Fixtures.Session(TenantA))
        assert.equal(res.status, 404)
        assert.deepEqual(deployments.Targets, [])
    })

    it('409s a roll to a version not gated to the tenant, with a generic body that does not echo the version', async () =>
    {
        const res = await Handle(Fixtures.PostJson({ version: 'v2' }), '/tenant-api/hives/hive-a/target', Fixtures.Session(TenantA))
        assert.equal(res.status, 409)
        assert.doesNotMatch(res.body, /v2/)
        assert.deepEqual(deployments.Targets, [{ hiveId: 'hive-a', version: 'v2' }])
    })

    it('404s a roll to an unknown version with a generic body', async () =>
    {
        const res = await Handle(Fixtures.PostJson({ version: 'ghost' }), '/tenant-api/hives/hive-a/target', Fixtures.Session(TenantA))
        assert.equal(res.status, 404)
        assert.doesNotMatch(res.body, /ghost/)
    })

    it('400s a roll with a missing version', async () =>
    {
        const res = await Handle(Fixtures.PostJson({}), '/tenant-api/hives/hive-a/target', Fixtures.Session(TenantA))
        assert.equal(res.status, 400)
        assert.deepEqual(deployments.Targets, [])
    })

    it('Stop on an in-cluster env succeeds and reports the Stopped status', async () =>
    {
        const res = await Handle(Fixtures.Post(), '/tenant-api/environments/a-env/stop', Fixtures.Session(TenantA))
        assert.equal(res.status, 200)
        assert.equal((res.Json() as { status: string }).status, EnvStatus.Stopped)
    })

    for (const action of Object.values(TenantEnvAction))
    {
        it(`${action}s the tenant\'s own environment and returns its DTO`, async () =>
        {
            const res = await Handle(Fixtures.Post(), `/tenant-api/environments/a-env/${action}`, Fixtures.Session(TenantA))
            assert.equal(res.status, 200)
            const dto = res.Json() as { name: string; status: string }
            assert.equal(dto.name, 'a-env')
            assert.deepEqual(service.Calls, [{ action, name: 'a-env' }])
        })

        it(`404s a ${action} against another tenant\'s environment and never calls the service action`, async () =>
        {
            const res = await Handle(Fixtures.Post(), `/tenant-api/environments/b-env/${action}`, Fixtures.Session(TenantA))
            assert.equal(res.status, 404)
            assert.deepEqual(service.Calls, [])
        })

        it(`404s a ${action} against an unknown environment`, async () =>
        {
            const res = await Handle(Fixtures.Post(), `/tenant-api/environments/nope/${action}`, Fixtures.Session(TenantA))
            assert.equal(res.status, 404)
            assert.deepEqual(service.Calls, [])
        })
    }

    it('derives the tenant from the session, not the path: an A session cannot roll a B hive even though the hive id is in the URL', async () =>
    {
        await Handle(Fixtures.PostJson({ version: 'v2' }), '/tenant-api/hives/hive-b/target', Fixtures.Session(TenantA))
        // And the B session CAN roll it (proving the hive itself is rollable; only the A session was blocked).
        const ok = await Handle(Fixtures.PostJson({ version: 'v2' }), '/tenant-api/hives/hive-b/target', Fixtures.Session(TenantB))
        assert.equal(ok.status, 204)
        assert.deepEqual(deployments.Targets, [{ hiveId: 'hive-b', version: 'v2' }])
    })
})
