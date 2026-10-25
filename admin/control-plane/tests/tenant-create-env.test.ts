import { strict as assert } from 'node:assert'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { beforeEach, describe, it } from 'node:test'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { EnvironmentExistsError } from '../environment-service.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'
import { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import type { IEnvironmentService } from '../control-plane-host.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

class ResRecorder
{
    public status = 0
    public body = ''

    public writeHead(status: number): this
    {
        this.status = status
        return this
    }

    public end(body?: string): void
    {
        this.body = body ?? ''
    }

    public Json(): unknown
    {
        return JSON.parse(this.body)
    }
}

type CreateCall = { name: string; template: Template; type: EnvType; hostPort: number | undefined; hiveId: string | undefined }

class FakeService
{
    public readonly Calls: CreateCall[] = []
    public Failure: Error | undefined

    public async Create(name: string, template: Template, type: EnvType, hostPort?: number, hiveId?: string): Promise<EnvironmentRecord>
    {
        this.Calls.push({ name, template, type, hostPort, hiveId })
        if (this.Failure) throw this.Failure
        return {
            name, type, template, environmentId: 'eid-' + name, tenantId: 't-a', hiveId, hostPort: 8101,
            createdAt: '2026-01-01T00:00:00Z', status: EnvStatus.Running
        }
    }
}

class FakeDirectory implements ITenantDirectory
{
    public constructor(private readonly hives: readonly HiveRecord[])
    {
    }

    public GetTenant(): undefined
    {
        return undefined
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

class Fixtures
{
    public static Hive(id: string, tenantId: string): HiveRecord
    {
        return { id, tenantId, displayName: id, cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach } } as unknown as HiveRecord
    }

    public static Session(tenantId: string): TenantSession
    {
        return { id: 'sess-' + tenantId, tenantId, principalId: 'p-' + tenantId, expiresAt: '2099-01-01T00:00:00Z' }
    }

    public static PostRaw(raw: string): IncomingMessage
    {
        const stream = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage & { method?: string }
        stream.method = 'POST'
        return stream
    }

    public static PostJson(body: unknown): IncomingMessage
    {
        return Fixtures.PostRaw(JSON.stringify(body))
    }

    public static Valid(): IncomingMessage
    {
        return Fixtures.PostJson({ name: 'e1', template: Template.DevBlank, type: EnvType.Development })
    }
}

describe('TenantApiEndpoint POST /tenant-api/environments', () =>
{
    const Path = '/tenant-api/environments'
    let service: FakeService
    let endpoint: TenantApiEndpoint

    function Build(hives: readonly HiveRecord[]): void
    {
        service = new FakeService()
        endpoint = new TenantApiEndpoint(
            service as unknown as IEnvironmentService,
            new FakeDirectory(hives),
            {} as never,
            {} as never,
            {} as never)
    }

    async function Post(req: IncomingMessage, tenantId = 't-a'): Promise<ResRecorder>
    {
        const res = new ResRecorder()
        assert.equal(await endpoint.Handle(req, res as unknown as ServerResponse, Path, Fixtures.Session(tenantId)), true)
        return res
    }

    beforeEach(() =>
    {
        Build([Fixtures.Hive('hive-a', 't-a'), Fixtures.Hive('hive-b', 't-b')])
    })

    it('creates in the session tenant hive and returns 201 + DTO', async () =>
    {
        const res = await Post(Fixtures.Valid())
        assert.equal(res.status, 201)
        assert.deepEqual(service.Calls, [{ name: 'e1', template: Template.DevBlank, type: EnvType.Development, hostPort: undefined, hiveId: 'hive-a' }])
        const dto = res.Json() as { name: string; hiveId: string }
        assert.equal(dto.name, 'e1')
        assert.equal(dto.hiveId, 'hive-a')
    })

    it('ignores a body hiveId naming another tenant hive', async () =>
    {
        const res = await Post(Fixtures.PostJson({ name: 'e1', template: Template.DevBlank, type: EnvType.Development, hiveId: 'hive-b', tenantId: 't-b' }))
        assert.equal(res.status, 201)
        assert.equal(service.Calls[0]?.hiveId, 'hive-a')
    })

    const BadBodies: Array<[string, () => IncomingMessage]> = [
        ['missing name', () => Fixtures.PostJson({ template: Template.DevBlank, type: EnvType.Development })],
        ['empty name', () => Fixtures.PostJson({ name: '', template: Template.DevBlank, type: EnvType.Development })],
        ['non-string name', () => Fixtures.PostJson({ name: 5, template: Template.DevBlank, type: EnvType.Development })],
        ['unknown template', () => Fixtures.PostJson({ name: 'e1', template: 'nope', type: EnvType.Development })],
        ['unknown type', () => Fixtures.PostJson({ name: 'e1', template: Template.DevBlank, type: 'nope' })],
        ['malformed json', () => Fixtures.PostRaw('{not json')],
        ['non-object', () => Fixtures.PostJson([1])],
        ['oversized body', () => Fixtures.PostJson({ name: 'x'.repeat(10000), template: Template.DevBlank, type: EnvType.Development })]
    ]
    for (const [label, make] of BadBodies)
    {
        it(`400s ${label} and never calls Create`, async () =>
        {
            const res = await Post(make())
            assert.equal(res.status, 400)
            assert.equal(service.Calls.length, 0)
        })
    }

    it('409s a tenant with no hive and never calls Create', async () =>
    {
        const res = await Post(Fixtures.Valid(), 't-none')
        assert.equal(res.status, 409)
        assert.equal(service.Calls.length, 0)
    })

    it('409s EnvironmentExistsError with a fixed body', async () =>
    {
        service.Failure = new EnvironmentExistsError('e1')
        const res = await Post(Fixtures.Valid())
        assert.equal(res.status, 409)
        assert.doesNotMatch(res.body, /e1/)
    })

    it('400s UnsupportedBackendError with a fixed body', async () =>
    {
        const failure = new UnsupportedBackendError(HiveBackend.Local, InfraMode.Attach)
        service.Failure = failure
        const res = await Post(Fixtures.Valid())
        assert.equal(res.status, 400)
        assert.equal(res.body.includes(failure.message), false)
    })

    it('answers a fixed generic 500 for any other failure without echoing its text', async () =>
    {
        service.Failure = new Error('secret-host-detail')
        const res = await Post(Fixtures.Valid())
        assert.equal(res.status, 500)
        assert.doesNotMatch(res.body, /secret-host-detail/)
    })
})
