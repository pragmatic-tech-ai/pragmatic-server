import { strict as assert } from 'node:assert'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import type { IEnvironmentService } from '../control-plane-host.js'
import { EnvironmentPlacement } from '../environment-placement.js'
import { HivePlacementError } from '../hive-placement-error.js'
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

    public async ManifestsFor(_tenantId: string): Promise<readonly ManifestRecord[]>
    {
        return []
    }

    public async StatusFor(_hiveId: string): Promise<HiveRolloutStatus>
    {
        return { targetVersion: undefined, environments: [] }
    }

    public async AdoptTarget(hiveId: string, version: string): Promise<void>
    {
        this.Adopted.push({ hiveId, version })
    }
}

/** Records the status the endpoint wrote; no socket involved. */
class FakeResponse
{
    public status = 0
    public headersSent = false

    public setHeader(_name: string, _value: string | number | string[]): void
    {
    }

    public writeHead(status: number): this
    {
        this.status = status
        this.headersSent = true
        return this
    }

    public end(_body?: string): void
    {
    }
}

/** An environment service listing a fixed set of records. */
class FakeEnvironmentService
{
    public constructor(private readonly records: readonly EnvironmentRecord[])
    {
    }

    public List(): readonly EnvironmentRecord[]
    {
        return this.records
    }
}

class Kit
{
    public static readonly Tenant = 't-a'
    public static readonly Hive = 'hive-a'
    public static readonly ClientId = 'c'
    public static readonly DisplayName = 'T'
    public static readonly EnvName = 'e'
    public static readonly EnvId = 'eid'
    public static readonly CreatedAt = '2026-01-01T00:00:00Z'
    public static readonly ExpiresAt = '2099-01-01T00:00:00Z'
    public static readonly PrincipalId = 'p'
    public static readonly ContainerName = 'c'
    public static readonly VolumeName = 'v'
    public static readonly BundleDir = '/b'
    public static readonly HostPort = 8101
    public static readonly MethodPost = 'POST'
    public static readonly Version = 'v1'
    public static readonly OtherTenant = 'other'
    public static readonly UnknownTenant = 'nope'
    public static readonly BaseDomain = 'admin.example.com'
    public static readonly Scheme = 'https'
    public static readonly HostSuffix = '.' + Kit.BaseDomain
    public static readonly TargetPath = '/tenant-api/hives/' + Kit.Hive + '/target'
    public static readonly SessionId = 's'

    public static TenantRec(): TenantRecord
    {
        return { id: Kit.Tenant, clientId: Kit.ClientId, displayName: Kit.DisplayName, createdAt: Kit.CreatedAt }
    }

    public static HiveRec(): HiveRecord
    {
        return {
            id: Kit.Hive, tenantId: Kit.Tenant, displayName: Kit.DisplayName, createdAt: Kit.CreatedAt,
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
            name: Kit.EnvName, type: EnvType.Development, template: Template.DevBlank, environmentId: Kit.EnvId, tenantId: Kit.Tenant, hiveId: Kit.Hive,
            hostPort: Kit.HostPort, containerName: Kit.ContainerName, volumeName: Kit.VolumeName, bundleDir: Kit.BundleDir, createdAt: Kit.CreatedAt, status: EnvStatus.Running
        }
    }

    public static Session(): TenantSession
    {
        return { id: Kit.SessionId, tenantId: Kit.Tenant, principalId: Kit.PrincipalId, expiresAt: Kit.ExpiresAt }
    }

    public static PostJson(body: unknown): IncomingMessage
    {
        const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage & { method?: string }
        stream.method = Kit.MethodPost
        return stream
    }

    public static Res(): FakeResponse
    {
        return new FakeResponse()
    }
}

describe('tenant plane depends on narrow seams', () =>
{
    it('TenantHostResolver resolves via an ITenantDirectory-only fake', () =>
    {
        const resolver = new TenantHostResolver(Kit.BaseDomain, Kit.Scheme, Kit.Directory())
        assert.equal(resolver.TenantFor(Kit.Tenant + Kit.HostSuffix), Kit.Tenant)
        assert.equal(resolver.TenantFor(Kit.UnknownTenant + Kit.HostSuffix), undefined)
    })

    it('TenantApiEndpoint adopts a target through IRolloutClient.AdoptTarget', async () =>
    {
        const rollout = new FakeRolloutClient()
        const service = new FakeEnvironmentService([Kit.Env()]) as unknown as IEnvironmentService
        const endpoint = new TenantApiEndpoint(service, Kit.Directory(), rollout, new HiveOrchestratorFactory(), new EnvironmentPlacement(Kit.Directory()))
        const res = Kit.Res()
        const handled = await endpoint.Handle(Kit.PostJson({ version: Kit.Version }), res as unknown as ServerResponse, Kit.TargetPath, Kit.Session())
        assert.equal(handled, true)
        assert.equal(res.status, 204)
        assert.deepEqual(rollout.Adopted, [{ hiveId: Kit.Hive, version: Kit.Version }])
    })

    it('EnvironmentPlacement validates ownership against an ITenantDirectory-only fake', () =>
    {
        const placement = new EnvironmentPlacement(Kit.Directory())
        assert.equal(placement.WorkloadFor(Kit.Env()).hiveId, Kit.Hive)
        assert.throws(() => placement.WorkloadFor({ ...Kit.Env(), tenantId: Kit.OtherTenant }), HivePlacementError)
    })
})
