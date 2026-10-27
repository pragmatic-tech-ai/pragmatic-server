import { strict as assert } from 'node:assert'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import type { IEnvironmentService } from '../control-plane-host.js'
import type { TenantRecord } from '../platform-records.js'
import { SeededTenantDirectory } from '../tenant-api/seeded-tenant-directory.js'
import { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

/** Records what the endpoint wrote so a test can assert on status and JSON body without a real socket. */
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
}

/** Answers every Admin*, lifecycle and list call with a benign value; the guard test only cares about the HTTP status. */
class FakeService
{
    public Calls = 0

    public constructor(private readonly records: readonly EnvironmentRecord[])
    {
    }

    public List(): readonly EnvironmentRecord[]
    {
        return this.records
    }

    public async Start(name: string): Promise<EnvironmentRecord>
    {
        this.Calls++
        return { ...this.records.find(r => r.name === name)!, status: EnvStatus.Running }
    }

    public async AdminSnapshot(): Promise<unknown>
    {
        this.Calls++
        return { accounts: [], grants: [], config: {} }
    }

    public async AdminCreateAccount(): Promise<void>
    {
        this.Calls++
    }

    public async AdminDisableAccount(): Promise<void>
    {
        this.Calls++
    }

    public async AdminGrantRole(): Promise<void>
    {
        this.Calls++
    }

    public async AdminRevokeRole(): Promise<void>
    {
        this.Calls++
    }

    public async AdminSetSecurityModel(): Promise<void>
    {
        this.Calls++
    }

    public async AdminSetConfig(): Promise<void>
    {
        this.Calls++
    }

    public async AdminIssueToken(): Promise<unknown>
    {
        this.Calls++
        return { token: 't', tokenRef: 'r1', principalId: 'svc', scopes: ['read'], expiresAt: null }
    }

    public async AdminRevokeToken(): Promise<void>
    {
        this.Calls++
    }

    public async AdminListTokens(): Promise<unknown>
    {
        this.Calls++
        return []
    }

    public async AdminGetConfig(): Promise<unknown>
    {
        this.Calls++
        return { packId: 'local' }
    }

    public async AdminGetSecurityModel(): Promise<unknown>
    {
        this.Calls++
        return undefined
    }

    public async AdminIssueMakerToken(): Promise<unknown>
    {
        this.Calls++
        return { token: 't', principalId: 'maker', expiresAt: 'x' }
    }

    public async AdminGrantAppReader(): Promise<void>
    {
        this.Calls++
    }
}

class Route
{
    public constructor(
        public readonly Method: string,
        public readonly Suffix: string,
        public readonly Body?: unknown)
    {
    }
}

class Fixtures
{
    public static readonly TenantId = 't-a'
    public static readonly OwnerId = 'owner-1'
    public static readonly Base = '/tenant-api/environments/a-env/'
    public static readonly Forbidden = { error: 'forbidden' }
    public static readonly Grant = { subject: 's1', role: 'admin', resourceKind: 'graph', resourcePath: '/g' }

    public static readonly Guarded: Route[] = [
        new Route('POST', 'admin/accounts', { email: 'a@b.c', principalId: 'p1', password: 'pw' }),
        new Route('DELETE', 'admin/accounts/user%2F1'),
        new Route('POST', 'admin/grants', Fixtures.Grant),
        new Route('DELETE', 'admin/grants', Fixtures.Grant),
        new Route('POST', 'admin/tokens', { principalId: 'svc', scopes: ['read'], expiresInSeconds: 60 }),
        new Route('DELETE', 'admin/tokens', { tokenRef: 'r' }),
        new Route('PUT', 'admin/security-model', { securityModel: { roles: [] } }),
        new Route('PUT', 'admin/config', { packId: 'local', delegationDepth: 'one' })
    ]

    public static readonly Open: Route[] = [
        new Route('GET', 'admin/snapshot'),
        new Route('GET', 'admin/config'),
        new Route('GET', 'admin/tokens'),
        new Route('GET', 'admin/security-model'),
        new Route('POST', 'maker-token'),
        new Route('POST', 'app-reader-grant')
    ]

    public static readonly Unrouted: Route[] = [
        new Route('PUT', 'admin/accounts', {}),
        new Route('POST', 'admin/security-model', {}),
        new Route('POST', 'admin/config', {}),
        new Route('DELETE', 'admin/config', {}),
        new Route('POST', 'admin/accounts/user%2F1', {}),
        new Route('DELETE', 'admin/grants/extra', {}),
        new Route('PUT', 'admin/tokens', {})
    ]

    public static Tenant(owner: boolean): TenantRecord
    {
        const t: TenantRecord = { id: Fixtures.TenantId, clientId: 'c', displayName: 'A', createdAt: '2026-01-01T00:00:00Z' }
        return owner ? { ...t, ownerPrincipalId: Fixtures.OwnerId } : t
    }

    public static Build(owner: boolean, envTenant: string = Fixtures.TenantId): { endpoint: TenantApiEndpoint; service: FakeService }
    {
        const env: EnvironmentRecord = {
            name: 'a-env', type: EnvType.Development, template: Template.DevBlank, environmentId: 'eid', tenantId: envTenant, hiveId: undefined, hostPort: 8101,
            containerName: 'c', volumeName: 'v', bundleDir: '/b', createdAt: '2026-01-01T00:00:00Z', status: EnvStatus.Stopped
        }
        const directory = new SeededTenantDirectory({ tenant: Fixtures.Tenant(owner), hives: [] })
        const service = new FakeService([env])
        return { endpoint: new TenantApiEndpoint(service as unknown as IEnvironmentService, directory, undefined as never, undefined as never, undefined as never), service }
    }

    public static Session(principalId: string): TenantSession
    {
        return { id: 'sess', tenantId: Fixtures.TenantId, principalId, expiresAt: '2099-01-01T00:00:00Z' }
    }

    public static Req(method: string, body?: unknown): IncomingMessage
    {
        const text = body === undefined ? '' : JSON.stringify(body)
        const stream = Readable.from(text.length === 0 ? [] : [Buffer.from(text)]) as unknown as IncomingMessage & { method?: string; headers?: Record<string, string> }
        stream.method = method
        stream.headers = { 'content-length': String(Buffer.byteLength(text)) }
        return stream
    }

    public static async Send(endpoint: TenantApiEndpoint, session: TenantSession, method: string, path: string, body?: unknown): Promise<ResRecorder>
    {
        const res = new ResRecorder()
        assert.equal(await endpoint.Handle(Fixtures.Req(method, body), res as unknown as ServerResponse, path, session), true)
        return res
    }
}

describe('TenantApiEndpoint capability guard', () =>
{
    for (const r of Fixtures.Guarded)
    {
        it(`${r.Method} ${r.Suffix} is 403 generic for a non-owner and never reaches the handler`, async () =>
        {
            const f = Fixtures.Build(true)
            const res = await Fixtures.Send(f.endpoint, Fixtures.Session('someone-else'), r.Method, Fixtures.Base + r.Suffix, r.Body)
            assert.equal(res.status, 403)
            assert.deepEqual(JSON.parse(res.body), Fixtures.Forbidden)
            assert.equal(f.service.Calls, 0)
        })

        it(`${r.Method} ${r.Suffix} is allowed for the owner and reaches the handler`, async () =>
        {
            const f = Fixtures.Build(true)
            const res = await Fixtures.Send(f.endpoint, Fixtures.Session(Fixtures.OwnerId), r.Method, Fixtures.Base + r.Suffix, r.Body)
            assert.ok(res.status === 200 || res.status === 201, `status ${res.status}`)
            assert.equal(f.service.Calls, 1)
        })

        it(`${r.Method} ${r.Suffix} is allowed when the tenant records no owner (fail-open)`, async () =>
        {
            const f = Fixtures.Build(false)
            const res = await Fixtures.Send(f.endpoint, Fixtures.Session('someone-else'), r.Method, Fixtures.Base + r.Suffix, r.Body)
            assert.ok(res.status === 200 || res.status === 201, `status ${res.status}`)
            assert.equal(f.service.Calls, 1)
        })

        it(`${r.Method} ${r.Suffix} on a foreign environment is 404 (ownership wins over 403)`, async () =>
        {
            const f = Fixtures.Build(true, 't-other')
            const res = await Fixtures.Send(f.endpoint, Fixtures.Session('someone-else'), r.Method, Fixtures.Base + r.Suffix, r.Body)
            assert.equal(res.status, 404)
            assert.equal(f.service.Calls, 0)
        })
    }

    for (const r of Fixtures.Open)
    {
        it(`${r.Method} ${r.Suffix} stays open for a non-owner`, async () =>
        {
            const f = Fixtures.Build(true)
            const res = await Fixtures.Send(f.endpoint, Fixtures.Session('someone-else'), r.Method, Fixtures.Base + r.Suffix, r.Body)
            assert.ok(res.status === 200 || res.status === 201, `status ${res.status}`)
            assert.equal(f.service.Calls, 1)
        })
    }

    for (const r of Fixtures.Unrouted)
    {
        it(`${r.Method} ${r.Suffix} (no such route) is 404 for a non-owner, not 403`, async () =>
        {
            const f = Fixtures.Build(true)
            const res = await Fixtures.Send(f.endpoint, Fixtures.Session('someone-else'), r.Method, Fixtures.Base + r.Suffix, r.Body)
            assert.equal(res.status, 404)
            assert.equal(f.service.Calls, 0)
        })
    }

    it('environment start stays open for a non-owner', async () =>
    {
        const f = Fixtures.Build(true)
        const res = await Fixtures.Send(f.endpoint, Fixtures.Session('someone-else'), 'POST', '/tenant-api/environments/a-env/start')
        assert.equal(res.status, 200)
        assert.equal(f.service.Calls, 1)
    })
})
