import { strict as assert } from 'node:assert'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import type { IEnvironmentService } from '../control-plane-host.js'
import { EnvironmentPlacement } from '../environment-placement.js'
import { HivePlacementError } from '../platform-directory.js'
import type { ManifestRecord } from '../manifest-record.js'
import type { HiveRolloutStatus } from '../platform-deployment-registry.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { IRolloutClient } from '../tenant-api/rollout-client.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import { TenantHostResolver } from '../tenant-auth/tenant-host-resolver.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

/** A hand-written directory implementing ONLY the narrow tenant seam. */
class FakeTenantDirectory implements ITenantDirectory
{
    public constructor(private readonly tenants: readonly TenantRecord[], private readonly hives: readonly HiveRecord[])
    {
    }

    public GetTenant(id: string): TenantRecord | undefined
    {
        return this.tenants.find(t => t.id === id)
    }

    public GetHive(id: string): HiveRecord | undefined
    {
        return this.hives.find(h => h.id === id)
    }

    public ListHives(tenantId: string): readonly HiveRecord[]
    {
        return this.hives.filter(h => h.tenantId === tenantId)
    }
}

/** A hand-written rollout client implementing ONLY the narrow rollout seam; records adoptions. */
class FakeRolloutClient implements IRolloutClient
{
    public readonly Adopted: Array<{ hiveId: string; version: string }> = []

    public ManifestsFor(_tenantId: string): readonly ManifestRecord[]
    {
        return []
    }

    public StatusFor(_hiveId: string): HiveRolloutStatus
    {
        return { targetVersion: undefined, environments: [] }
    }

    public async AdoptTarget(hiveId: string, version: string): Promise<void>
    {
        this.Adopted.push({ hiveId, version })
    }
}

class Kit
{
    public static readonly Tenant = 't-a'
    public static readonly Hive = 'hive-a'

    public static TenantRec(): TenantRecord
    {
        return { id: Kit.Tenant, clientId: 'c', displayName: 'T', createdAt: '2026-01-01T00:00:00Z' }
    }

    public static HiveRec(): HiveRecord
    {
        return {
            id: Kit.Hive, tenantId: Kit.Tenant, displayName: 'H', createdAt: '2026-01-01T00:00:00Z',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach }
        }
    }

    public static Directory(): FakeTenantDirectory
    {
        return new FakeTenantDirectory([Kit.TenantRec()], [Kit.HiveRec()])
    }

    public static Env(): EnvironmentRecord
    {
        return {
            name: 'e', type: EnvType.Development, template: Template.DevBlank, environmentId: 'eid', tenantId: Kit.Tenant, hiveId: Kit.Hive,
            hostPort: 8101, containerName: 'c', volumeName: 'v', bundleDir: '/b', createdAt: '2026-01-01T00:00:00Z', status: EnvStatus.Running
        }
    }

    public static Session(): TenantSession
    {
        return { id: 's', tenantId: Kit.Tenant, principalId: 'p', expiresAt: '2099-01-01T00:00:00Z' }
    }

    public static PostJson(body: unknown): IncomingMessage
    {
        const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage & { method?: string }
        stream.method = 'POST'
        return stream
    }

    public static Res(): ServerResponse & { status: number }
    {
        const res = {
            status: 0, headersSent: false,
            setHeader(): void { },
            writeHead(s: number) { res.status = s; res.headersSent = true; return res },
            end(): void { },
        }
        return res as unknown as ServerResponse & { status: number }
    }
}

describe('tenant plane depends on narrow seams', () =>
{
    it('TenantHostResolver resolves via an ITenantDirectory-only fake', () =>
    {
        const resolver = new TenantHostResolver('admin.example.com', 'https', Kit.Directory())
        assert.equal(resolver.TenantFor('t-a.admin.example.com'), 't-a')
        assert.equal(resolver.TenantFor('nope.admin.example.com'), undefined)
    })

    it('TenantApiEndpoint adopts a target through IRolloutClient.AdoptTarget', async () =>
    {
        const rollout = new FakeRolloutClient()
        const service = { List: () => [Kit.Env()] } as unknown as IEnvironmentService
        const endpoint = new TenantApiEndpoint(service, Kit.Directory(), rollout, new HiveOrchestratorFactory(), new EnvironmentPlacement(Kit.Directory()))
        const res = Kit.Res()
        const handled = await endpoint.Handle(Kit.PostJson({ version: 'v1' }), res, '/tenant-api/hives/hive-a/target', Kit.Session())
        assert.equal(handled, true)
        assert.equal(res.status, 204)
        assert.deepEqual(rollout.Adopted, [{ hiveId: Kit.Hive, version: 'v1' }])
    })

    it('EnvironmentPlacement validates ownership against an ITenantDirectory-only fake', () =>
    {
        const placement = new EnvironmentPlacement(Kit.Directory())
        assert.equal(placement.WorkloadFor(Kit.Env()).hiveId, Kit.Hive)
        assert.throws(() => placement.WorkloadFor({ ...Kit.Env(), tenantId: 'other' }), HivePlacementError)
    })
})
