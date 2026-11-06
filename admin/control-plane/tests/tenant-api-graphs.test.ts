import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { AuditRegistry, type AuditRecord } from '../audit-record.js'
import { AdminProxyError, AdminProxyErrorKind } from '../admin-proxy.js'
import type { GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { GraphDto, IEnvironmentService, IGraphService, PromotionResultDto } from '../control-plane-host.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { GraphExistsError, GraphNameInvalidError, GraphNotFoundError } from '../graph-service.js'
import { TenantAdminCapabilities } from '../tenant-api/tenant-admin-capabilities.js'
import { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { TenantGraphAccess } from '../tenant-api/tenant-graph-access.js'
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

/** A graph service that records every call and answers fixed DTOs, or throws `Throw` when it is set. */
class FakeGraphs implements IGraphService
{
    public readonly Calls: unknown[][] = []
    public Throw: Error | undefined
    public readonly Listed: readonly GraphDto[] = [
        { name: 'sales', description: 'd', packageCount: 2, createdAt: '2026-11-01T00:00:00.000Z' },
        { name: 'ops', description: '', packageCount: 0, createdAt: '2026-11-02T00:00:00.000Z' },
    ]

    public async Create(envName: string, name: string, description: string): Promise<GraphDto>
    {
        this.Calls.push(['Create', envName, name, description])
        this.Fail()
        return { name, description, packageCount: 0, createdAt: '2026-11-06T00:00:00.000Z' }
    }

    public async List(envName: string): Promise<readonly GraphDto[]>
    {
        this.Calls.push(['List', envName])
        this.Fail()
        return this.Listed
    }

    public async Get(envName: string, graphName: string): Promise<GraphDto>
    {
        this.Calls.push(['Get', envName, graphName])
        this.Fail()
        return this.Listed[0] as GraphDto
    }

    public async Delete(envName: string, graphName: string): Promise<void>
    {
        this.Calls.push(['Delete', envName, graphName])
        this.Fail()
    }

    public async Promote(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
    {
        this.Calls.push(['Promote', sourceEnv, graphName, targetEnv])
        this.Fail()
        return { graphName, packageCount: 0, targetEnv }
    }

    public async GetLoaded(runtimeEnv: string): Promise<GraphLoadedDto | null>
    {
        this.Calls.push(['GetLoaded', runtimeEnv])
        this.Fail()
        return null
    }

    private Fail(): void
    {
        if (this.Throw !== undefined)
        {
            throw this.Throw
        }
    }
}

class Fixtures
{
    public static readonly Base = '/tenant-api/environments/'
    public static readonly DevGraphs = Fixtures.Base + 'dev1/graphs'
    public static readonly BadJsonMessage = 'Request body must be valid JSON'
    public static readonly BodyObjectMessage = 'Request body must be a JSON object'
    public static readonly Session: TenantSession = { id: 's1', tenantId: 't1', principalId: 'p1', email: 'o@acme.test', expiresAt: '2099-01-01T00:00:00Z' }

    public static Env(name: string, type: EnvType, tenantId: string): EnvironmentRecord
    {
        return {
            name, type, template: Template.DevBlank, environmentId: 'eid-' + name, tenantId, hiveId: 'h1', hostPort: 8101,
            containerName: 'c-' + name, volumeName: 'v-' + name, bundleDir: '/b/' + name, createdAt: '2026-01-01T00:00:00Z', status: EnvStatus.Running
        }
    }

    public static readonly Envs: readonly EnvironmentRecord[] = [
        Fixtures.Env('dev1', EnvType.Development, 't1'),
        Fixtures.Env('rt1', EnvType.Runtime, 't1'),
        Fixtures.Env('other', EnvType.Development, 't2'),
    ]

    /** A request whose body is `raw` verbatim (undefined sends none). */
    public static Req(method: string, raw?: string): IncomingMessage
    {
        const text = raw ?? ''
        const stream = Readable.from(text.length === 0 ? [] : [Buffer.from(text)]) as unknown as IncomingMessage & { method?: string; headers?: Record<string, string> }
        stream.method = method
        stream.headers = { 'content-length': String(Buffer.byteLength(text)) }
        return stream
    }

    public static Endpoint(access: TenantGraphAccess | undefined): TenantApiEndpoint
    {
        const service = { List: () => Fixtures.Envs } as unknown as IEnvironmentService
        const directory = { GetTenant: () => undefined, ListHives: () => [] } as unknown as ITenantDirectory
        return new TenantApiEndpoint(service, directory, undefined as never, undefined as never, undefined as never, undefined, access)
    }

    public static async Send(endpoint: TenantApiEndpoint, method: string, path: string, raw?: string): Promise<ResRecorder>
    {
        const res = new ResRecorder()
        assert.equal(await endpoint.Handle(Fixtures.Req(method, raw), res as unknown as ServerResponse, path, Fixtures.Session), true)
        return res
    }

    public static async Audit(file: string): Promise<readonly AuditRecord[]>
    {
        const reg = new AuditRegistry(file)
        await reg.Load()
        return [...reg.List()].sort((a, b) => a.at.localeCompare(b.at))
    }
}

describe('TenantApiEndpoint graph routes', () =>
{
    let dir: string
    let auditFile: string
    let audit: AuditRegistry
    let graphs: FakeGraphs
    let endpoint: TenantApiEndpoint

    beforeEach(async () =>
    {
        dir = mkdtempSync(join(tmpdir(), 'tenant-api-graphs-'))
        auditFile = join(dir, 'tenant-graph-audit.json')
        audit = new AuditRegistry(auditFile)
        await audit.Load()
        graphs = new FakeGraphs()
        endpoint = Fixtures.Endpoint(new TenantGraphAccess(graphs, audit))
    })

    afterEach(() =>
    {
        mock.restoreAll()
        rmSync(dir, { recursive: true, force: true })
    })

    it('lists the graphs of an owned Development environment', async () =>
    {
        const res = await Fixtures.Send(endpoint, 'GET', Fixtures.DevGraphs)
        assert.equal(res.status, 200)
        assert.deepEqual(res.Json(), graphs.Listed)
        assert.deepEqual(graphs.Calls, [['List', 'dev1']])
        assert.deepEqual(await Fixtures.Audit(auditFile), [])
    })

    it('creates a graph (201) and audits it', async () =>
    {
        const res = await Fixtures.Send(endpoint, 'POST', Fixtures.DevGraphs, JSON.stringify({ name: 'sales', description: 'd' }))
        assert.equal(res.status, 201)
        assert.deepEqual(res.Json(), { name: 'sales', description: 'd', packageCount: 0, createdAt: '2026-11-06T00:00:00.000Z' })
        assert.deepEqual(graphs.Calls, [['Create', 'dev1', 'sales', 'd']])
        const entries = await Fixtures.Audit(auditFile)
        assert.equal(entries.length, 1)
        const e = entries[0] as AuditRecord
        assert.equal(e.actor, 't1/o@acme.test')
        assert.equal(e.method, 'POST')
        assert.equal(e.path, Fixtures.DevGraphs)
        assert.equal(e.status, 201)
        assert.equal(e.note, 'environment=dev1 graph=sales')
        assert.ok(!Number.isNaN(Date.parse(e.at)))

        const bare = await Fixtures.Send(endpoint, 'POST', Fixtures.DevGraphs, JSON.stringify({ name: 'ops' }))
        assert.equal(bare.status, 201)
        assert.deepEqual(graphs.Calls[1], ['Create', 'dev1', 'ops', ''])
    })

    it('deletes a graph (204) and audits it', async () =>
    {
        const res = await Fixtures.Send(endpoint, 'DELETE', Fixtures.DevGraphs + '/sales')
        assert.equal(res.status, 204)
        assert.equal(res.body, '')
        assert.deepEqual(graphs.Calls, [['Delete', 'dev1', 'sales']])
        const entries = await Fixtures.Audit(auditFile)
        assert.equal(entries.length, 1)
        assert.equal(entries[0]?.status, 204)
        assert.equal(entries[0]?.method, 'DELETE')
        assert.equal(entries[0]?.note, 'environment=dev1 graph=sales')
    })

    it('answers 404 for an unknown or foreign environment without calling the service or auditing', async () =>
    {
        for (const env of ['other', 'nope'])
        {
            const path = Fixtures.Base + env + '/graphs'
            for (const [method, p, raw] of [['GET', path, undefined], ['POST', path, '{"name":"x"}'], ['DELETE', path + '/x', undefined]] as const)
            {
                const res = await Fixtures.Send(endpoint, method, p, raw)
                assert.equal(res.status, 404, method + ' ' + p)
                assert.deepEqual(res.Json(), { error: 'Not found' })
            }
        }
        assert.deepEqual(graphs.Calls, [])
        assert.deepEqual(await Fixtures.Audit(auditFile), [])
    })

    it('needs the envs capability for reads and writes', async () =>
    {
        mock.method(TenantAdminCapabilities, 'For', () => ({ roleLabel: 'x', capabilities: { envs: false, adopt: true, access: true, settings: true } }))
        for (const [method, path, raw] of [['GET', Fixtures.DevGraphs, undefined], ['POST', Fixtures.DevGraphs, '{"name":"sales"}'], ['DELETE', Fixtures.DevGraphs + '/sales', undefined]] as const)
        {
            const res = await Fixtures.Send(endpoint, method, path, raw)
            assert.equal(res.status, 403, method)
            assert.deepEqual(res.Json(), { error: 'forbidden' })
        }
        assert.deepEqual(graphs.Calls, [])
        const entries = await Fixtures.Audit(auditFile)
        assert.deepEqual(entries.map(e => [e.method, e.status]), [['POST', 403], ['DELETE', 403]])
    })

    it('answers 400 for a Runtime environment', async () =>
    {
        const path = Fixtures.Base + 'rt1/graphs'
        for (const [method, p, raw] of [['GET', path, undefined], ['POST', path, '{"name":"sales"}'], ['DELETE', path + '/sales', undefined]] as const)
        {
            const res = await Fixtures.Send(endpoint, method, p, raw)
            assert.equal(res.status, 400, method)
            assert.deepEqual(res.Json(), { error: TenantGraphAccess.NotDevelopmentMessage })
        }
        assert.deepEqual(graphs.Calls, [])
    })

    it('answers 503 with the sentence when there is no reach', async () =>
    {
        const unreachable = Fixtures.Endpoint(new TenantGraphAccess(undefined, audit))
        for (const [method, path, raw] of [['GET', Fixtures.DevGraphs, undefined], ['POST', Fixtures.DevGraphs, '{"name":"sales"}'], ['DELETE', Fixtures.DevGraphs + '/sales', undefined]] as const)
        {
            const res = await Fixtures.Send(unreachable, method, path, raw)
            assert.equal(res.status, 503, method)
            assert.deepEqual(res.Json(), { error: TenantGraphAccess.UnreachableMessage })
        }
        const entries = await Fixtures.Audit(auditFile)
        assert.deepEqual(entries.map(e => [e.method, e.status]), [['POST', 503], ['DELETE', 503]])
    })

    it('rejects a bad body with 400 before any call', async () =>
    {
        const cases: ReadonlyArray<[string, string]> = [
            ['{not json', Fixtures.BadJsonMessage],
            ['[]', Fixtures.BodyObjectMessage],
            ['{}', TenantGraphAccess.FieldsMessage],
            ['{"name":""}', TenantGraphAccess.FieldsMessage],
            ['{"name":"a","description":7}', TenantGraphAccess.FieldsMessage],
        ]
        for (const [raw, message] of cases)
        {
            const res = await Fixtures.Send(endpoint, 'POST', Fixtures.DevGraphs, raw)
            assert.equal(res.status, 400, raw)
            assert.deepEqual(res.Json(), { error: message }, raw)
        }
        assert.deepEqual(graphs.Calls, [])
        const entries = await Fixtures.Audit(auditFile)
        assert.equal(entries.length, cases.length)
        assert.ok(entries.every(e => e.status === 400))
        assert.deepEqual(entries.map(e => e.note).sort(), [
            'environment=dev1 graph=', 'environment=dev1 graph=', 'environment=dev1 graph=', 'environment=dev1 graph=', 'environment=dev1 graph=a'
        ])
    })

    it('maps service failures to the fixed statuses and sentences', async () =>
    {
        const cases: ReadonlyArray<[Error, number, string]> = [
            [new GraphExistsError('sales'), 409, TenantGraphAccess.ExistsMessage],
            [new GraphNotFoundError('sales'), 404, TenantGraphAccess.NotFoundMessage],
            [new GraphNameInvalidError('sales'), 400, TenantGraphAccess.NameInvalidMessage],
            [new AdminProxyError(AdminProxyErrorKind.Connect), 503, TenantGraphAccess.ConnectMessage],
            [new Error('secret host 10.0.0.1'), 500, TenantGraphAccess.FailedMessage],
        ]
        const logged: unknown[][] = []
        mock.method(console, 'error', (...args: unknown[]) => { logged.push(args) })
        const expected: Array<[string, number]> = []
        for (const [err, status, message] of cases)
        {
            graphs.Throw = err
            for (const [method, path, raw] of [['POST', Fixtures.DevGraphs, '{"name":"sales"}'], ['DELETE', Fixtures.DevGraphs + '/sales', undefined]] as const)
            {
                const res = await Fixtures.Send(endpoint, method, path, raw)
                assert.equal(res.status, status, method + ' ' + err.name)
                assert.deepEqual(res.Json(), { error: message })
                assert.ok(!res.body.includes('10.0.0.1'))
                expected.push([method, status])
            }
        }
        graphs.Throw = new Error('secret host 10.0.0.1')
        const listed = await Fixtures.Send(endpoint, 'GET', Fixtures.DevGraphs)
        assert.equal(listed.status, 500)
        assert.deepEqual(listed.Json(), { error: TenantGraphAccess.FailedMessage })
        assert.ok(!JSON.stringify(logged).includes('10.0.0.1'))
        assert.ok(logged.length > 0)
        const entries = await Fixtures.Audit(auditFile)
        assert.deepEqual(entries.map(e => [e.method, e.status]).sort(), expected.sort())
        assert.ok(entries.every(e => e.note === 'environment=dev1 graph=sales'))
    })

    it('a malformed or encoded graph segment never reaches another route', async () =>
    {
        const malformed = await Fixtures.Send(endpoint, 'DELETE', Fixtures.DevGraphs + '/%E0%A4%A')
        assert.equal(malformed.status, 404)
        assert.deepEqual(graphs.Calls, [])
        assert.deepEqual(await Fixtures.Audit(auditFile), [])

        const encoded = await Fixtures.Send(endpoint, 'DELETE', Fixtures.DevGraphs + '/a%2Fb')
        assert.equal(encoded.status, 204)
        assert.deepEqual(graphs.Calls, [['Delete', 'dev1', 'a/b']])

        const nested = await Fixtures.Send(endpoint, 'DELETE', Fixtures.DevGraphs + '/a/b')
        assert.equal(nested.status, 404)
        assert.deepEqual(nested.Json(), { error: 'Not found' })
        assert.equal(graphs.Calls.length, 1)
    })

    it('other method and path shapes answer 404', async () =>
    {
        for (const [method, path] of [['PUT', Fixtures.DevGraphs], ['GET', Fixtures.DevGraphs + '/sales'], ['POST', Fixtures.DevGraphs + '/sales'], ['DELETE', Fixtures.DevGraphs]] as const)
        {
            const res = await Fixtures.Send(endpoint, method, path, '{"name":"sales"}')
            assert.equal(res.status, 404, method + ' ' + path)
            assert.deepEqual(res.Json(), { error: 'Not found' })
        }
        assert.deepEqual(graphs.Calls, [])
        assert.deepEqual(await Fixtures.Audit(auditFile), [])
    })

    it('a failing audit write never changes the answer', async () =>
    {
        const logged: unknown[][] = []
        mock.method(console, 'error', (...args: unknown[]) => { logged.push(args) })
        mock.method(audit, 'Append', async () => { throw new Error('disk full at o@acme.test') })
        const res = await Fixtures.Send(endpoint, 'POST', Fixtures.DevGraphs, '{"name":"sales"}')
        assert.equal(res.status, 201)
        assert.deepEqual(graphs.Calls, [['Create', 'dev1', 'sales', '']])
        assert.equal(logged.length, 1)
        assert.ok(!JSON.stringify(logged).includes('o@acme.test'))
        assert.equal(logged[0]?.[1], 'Error')
    })

    it('clips every audited field to 128 characters', async () =>
    {
        const access = new TenantGraphAccess(graphs, audit)
        const long = 'x'.repeat(300)
        await access.Record({ ...Fixtures.Session, email: long }, long, long, 201, long, long)
        const e = (await Fixtures.Audit(auditFile))[0] as AuditRecord
        for (const field of [e.actor, e.method, e.path, e.note as string])
        {
            assert.equal(field.length, 128)
        }
    })

    it('an endpoint without graph access answers 404 on the graph paths', async () =>
    {
        const bare = Fixtures.Endpoint(undefined)
        for (const [method, path, raw] of [['GET', Fixtures.DevGraphs, undefined], ['POST', Fixtures.DevGraphs, '{"name":"sales"}'], ['DELETE', Fixtures.DevGraphs + '/sales', undefined]] as const)
        {
            const res = await Fixtures.Send(bare, method, path, raw)
            assert.equal(res.status, 404, method)
            assert.deepEqual(res.Json(), { error: 'Not found' })
        }
        assert.deepEqual(graphs.Calls, [])
        assert.deepEqual(await Fixtures.Audit(auditFile), [])
    })
})
