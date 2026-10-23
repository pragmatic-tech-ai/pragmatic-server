import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { EnvironmentPlacement } from '../environment-placement.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { RolloutFixture } from './rollout-fixture.js'
import { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
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

/** A minimal environment service: only List/ListReconciled are exercised by the read endpoint. */
class FakeService
{
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
}

class FakeOrchestrator implements IHiveOrchestrator
{
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

    public static Req(method: string): IncomingMessage
    {
        return { method } as unknown as IncomingMessage
    }
}

describe('TenantApiEndpoint read routes', () =>
{
    const TenantA = 't-a'
    const TenantB = 't-b'
    let parent: string
    let directory: PlatformDirectory
    let deployments: PlatformDeploymentRegistry
    let endpoint: TenantApiEndpoint

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'tenant-api-read-'))
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
        await directory.CreateHive({ id: 'hive-a', tenantId: TenantA, displayName: 'Hive A', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: 'ctx-a' }, registry: { mode: InfraMode.Attach, endpoint: 'registry.example.com', credentialRef: 'cred-ref-a' }, trustRootRef: 'trust-ref-a' })
        await directory.CreateHive({ id: 'hive-b', tenantId: TenantB, displayName: 'Hive B', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        // Give hive-a a server-side agent-token ref too; the tenant surface must omit both it and trustRootRef.
        await hives.Put({ ...directory.GetHive('hive-a')!, agentTokenRef: 'agent-ref-a' })
        const records = [
            Fixtures.Env('a-env', 'hive-a', TenantA),
            Fixtures.Env('b-env', 'hive-b', TenantB),
            Fixtures.Env('unbound', undefined, undefined),
        ]
        const service = new FakeService(records) as unknown as IEnvironmentService
        const orchestrators = new FakeFactory()
        deployments = await RolloutFixture.Create(parent, directory, orchestrators)
        await deployments.Publish('v1', 'registry/img:1')
        await deployments.Publish('v2', 'registry/img:2')
        await deployments.Gate(TenantA, 'v1')
        await deployments.Gate(TenantB, 'v2')
        await deployments.Report('hive-a', 'a-env', 'registry/img:1', true)
        endpoint = new TenantApiEndpoint(service, directory, deployments, orchestrators, new EnvironmentPlacement(directory))
    })

    afterEach(() =>
    {
        rmSync(parent, { recursive: true, force: true })
    })

    async function Get(path: string, session: TenantSession): Promise<ResRecorder>
    {
        const res = new ResRecorder()
        const handled = await endpoint.Handle(Fixtures.Req('GET'), res as unknown as ServerResponse, path, session)
        assert.equal(handled, true)
        return res
    }

    it('lists only the session tenant\'s hives', async () =>
    {
        const res = await Get('/tenant-api/hives', Fixtures.Session(TenantA))
        assert.equal(res.status, 200)
        assert.deepEqual((res.Json() as Array<{ id: string }>).map(h => h.id), ['hive-a'])
    })

    it('omits server-side token/trust refs from the tenant hives surface, keeping the coordinates a tenant needs', async () =>
    {
        const res = await Get('/tenant-api/hives', Fixtures.Session(TenantA))
        assert.equal(res.status, 200)
        const hive = (res.Json() as Array<Record<string, unknown>>)[0]!
        // The tenant-facing projection drops every server-side reference name...
        assert.equal('agentTokenRef' in hive, false)
        assert.equal('trustRootRef' in hive, false)
        assert.equal('configRef' in (hive.cluster as Record<string, unknown>), false)
        assert.equal('credentialRef' in (hive.registry as Record<string, unknown>), false)
        // ...but keeps everything a tenant admin needs.
        assert.deepEqual(Object.keys(hive).sort(), ['cluster', 'createdAt', 'displayName', 'id', 'registry', 'tenantId'])
        assert.equal(hive.id, 'hive-a')
        assert.equal(hive.tenantId, TenantA)
        assert.deepEqual(hive.cluster, { backend: HiveBackend.Local, mode: InfraMode.Attach })
        assert.deepEqual(hive.registry, { mode: InfraMode.Attach, endpoint: 'registry.example.com' })
        assert.doesNotMatch(res.body, /trust-ref-a|agent-ref-a|ctx-a|cred-ref-a/)
    })

    it('lists only the session tenant\'s environments, excluding other tenants and unbound envs', async () =>
    {
        const res = await Get('/tenant-api/environments', Fixtures.Session(TenantA))
        assert.equal(res.status, 200)
        const dtos = res.Json() as Array<{ name: string; httpUrl: string; wsUrl: string }>
        assert.deepEqual(dtos.map(d => d.name), ['a-env'])
        assert.match(dtos[0]!.httpUrl, /^http:\/\/localhost:/)
        assert.match(dtos[0]!.wsUrl, /^ws:\/\/localhost:/)
    })

    it('lists only the session tenant\'s gated manifests', async () =>
    {
        const res = await Get('/tenant-api/manifests', Fixtures.Session(TenantA))
        assert.equal(res.status, 200)
        assert.deepEqual((res.Json() as Array<{ id: string }>).map(m => m.id), ['v1'])
    })

    it('returns the rollout DTO for the tenant\'s own hive', async () =>
    {
        const res = await Get('/tenant-api/hives/hive-a/rollout', Fixtures.Session(TenantA))
        assert.equal(res.status, 200)
        const dto = res.Json() as { environments: Array<{ environmentName: string }> }
        assert.deepEqual(dto.environments.map(e => e.environmentName), ['a-env'])
    })

    it('404s rollout for another tenant\'s hive', async () =>
    {
        assert.equal((await Get('/tenant-api/hives/hive-b/rollout', Fixtures.Session(TenantA))).status, 404)
    })

    it('returns the health DTO list for the tenant\'s own hive', async () =>
    {
        const res = await Get('/tenant-api/hives/hive-a/health', Fixtures.Session(TenantA))
        assert.equal(res.status, 200)
        const dtos = res.Json() as Array<{ environmentName: string }>
        assert.deepEqual(dtos.map(d => d.environmentName), ['a-env'])
        assert.deepEqual(Object.keys(dtos[0]!).sort(), ['detail', 'environmentName', 'ready', 'runningImage'])
    })

    it('404s health for another tenant\'s hive', async () =>
    {
        assert.equal((await Get('/tenant-api/hives/hive-b/health', Fixtures.Session(TenantA))).status, 404)
    })

    it('404s rollout and health for a non-existent hive', async () =>
    {
        assert.equal((await Get('/tenant-api/hives/nope/rollout', Fixtures.Session(TenantA))).status, 404)
        assert.equal((await Get('/tenant-api/hives/nope/health', Fixtures.Session(TenantA))).status, 404)
    })

    it('404s an unknown tenant-api path and still reports it handled', async () =>
    {
        assert.equal((await Get('/tenant-api/nonsense', Fixtures.Session(TenantA))).status, 404)
    })

    it('never leaks secret fields', async () =>
    {
        const res = await Get('/tenant-api/environments', Fixtures.Session(TenantA))
        assert.doesNotMatch(res.body, /secret|password|token/i)
    })
})
