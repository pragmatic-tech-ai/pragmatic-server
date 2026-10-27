import { strict as assert } from 'node:assert'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { beforeEach, describe, it } from 'node:test'
import { AdminProxyError, AdminProxyErrorKind } from '../admin-proxy.js'
import { EnvironmentNotDevelopmentError, EnvironmentNotRuntimeError } from '../environment-service.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import type { IEnvironmentService } from '../control-plane-host.js'
import { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import { SeededTenantDirectory } from '../tenant-api/seeded-tenant-directory.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

/** Records what the endpoint wrote so a test can assert on status and JSON body without a real socket. */
class ResRecorder
{
    public status = 0
    public body = ''
    public headers: Record<string, string> = {}

    public writeHead(status: number, headers?: Record<string, string>): this
    {
        this.status = status
        this.headers = headers ?? {}
        return this
    }

    public end(body?: string): void
    {
        this.body = body ?? ''
    }

    public Json(): Record<string, unknown>
    {
        return JSON.parse(this.body) as Record<string, unknown>
    }
}

/** A fake service recording every Admin* call (method + args); `Throw` makes every Admin* call reject. */
class FakeService
{
    public readonly Calls: Array<{ method: string; args: unknown[] }> = []
    public Throw: Error | undefined

    public constructor(private readonly records: readonly EnvironmentRecord[])
    {
    }

    public List(): readonly EnvironmentRecord[]
    {
        return this.records
    }

    public async AdminSnapshot(...a: unknown[]): Promise<unknown>
    {
        return this.Rec('AdminSnapshot', a, { accounts: [], grants: [], config: {} })
    }

    public async AdminGetConfig(...a: unknown[]): Promise<unknown>
    {
        return this.Rec('AdminGetConfig', a, { packId: 'local' })
    }

    public async AdminGetSecurityModel(...a: unknown[]): Promise<unknown>
    {
        return this.Rec('AdminGetSecurityModel', a, undefined)
    }

    public async AdminCreateAccount(...a: unknown[]): Promise<void>
    {
        this.Rec('AdminCreateAccount', a, undefined)
    }

    public async AdminDisableAccount(...a: unknown[]): Promise<void>
    {
        this.Rec('AdminDisableAccount', a, undefined)
    }

    public async AdminGrantRole(...a: unknown[]): Promise<void>
    {
        this.Rec('AdminGrantRole', a, undefined)
    }

    public async AdminRevokeRole(...a: unknown[]): Promise<void>
    {
        this.Rec('AdminRevokeRole', a, undefined)
    }

    public async AdminSetSecurityModel(...a: unknown[]): Promise<void>
    {
        this.Rec('AdminSetSecurityModel', a, undefined)
    }

    public async AdminSetConfig(...a: unknown[]): Promise<void>
    {
        this.Rec('AdminSetConfig', a, undefined)
    }

    public async AdminIssueMakerToken(...a: unknown[]): Promise<unknown>
    {
        return this.Rec('AdminIssueMakerToken', a, { token: 'tok', principalId: 'maker', expiresAt: 'x' })
    }

    public async AdminListTokens(...a: unknown[]): Promise<unknown>
    {
        return this.Rec('AdminListTokens', a, [{ tokenRef: 'r1', principalId: 'svc', scopes: ['read'], expiresAt: null }])
    }

    public async AdminIssueToken(...a: unknown[]): Promise<unknown>
    {
        return this.Rec('AdminIssueToken', a, { token: 'secret-tok', tokenRef: 'r1', principalId: 'svc', scopes: ['read'], expiresAt: null })
    }

    public async AdminRevokeToken(...a: unknown[]): Promise<void>
    {
        this.Rec('AdminRevokeToken', a, undefined)
    }

    public async AdminGrantAppReader(...a: unknown[]): Promise<void>
    {
        this.Rec('AdminGrantAppReader', a, undefined)
    }

    private Rec(method: string, args: unknown[], result: unknown): unknown
    {
        this.Calls.push({ method, args })
        if (this.Throw !== undefined)
        {
            throw this.Throw
        }
        return result
    }
}

class Fixtures
{
    public static readonly TenantA = 't-a'
    public static readonly TenantB = 't-b'
    public static readonly Base = '/tenant-api/environments/'

    public static Env(name: string, tenantId: string): EnvironmentRecord
    {
        return {
            name, type: EnvType.Development, template: Template.DevBlank, environmentId: 'eid-' + name, tenantId, hiveId: undefined, hostPort: 8101,
            containerName: 'c-' + name, volumeName: 'v-' + name, bundleDir: '/b/' + name, createdAt: '2026-01-01T00:00:00Z', status: EnvStatus.Running
        }
    }

    /** A directory whose tenant records NO owner, so every session fails open to owner and the capability guard stays out of the way. */
    public static Directory(): SeededTenantDirectory
    {
        return new SeededTenantDirectory({ tenant: { id: Fixtures.TenantA, clientId: 'c', displayName: 'A', createdAt: '2026-01-01T00:00:00Z' }, hives: [] })
    }

    public static Session(tenantId: string): TenantSession
    {
        return { id: 'sess-' + tenantId, tenantId, principalId: 'p-' + tenantId, expiresAt: '2099-01-01T00:00:00Z' }
    }

    /** A request as a real readable stream with Content-Length set; a raw string body lets a test send malformed or oversized JSON. */
    public static Req(method: string, body?: unknown, raw?: string): IncomingMessage
    {
        const text = raw ?? (body === undefined ? '' : JSON.stringify(body))
        const stream = Readable.from(text.length === 0 ? [] : [Buffer.from(text)]) as unknown as IncomingMessage & { method?: string; headers?: Record<string, string> }
        stream.method = method
        stream.headers = { 'content-length': String(Buffer.byteLength(text)) }
        return stream
    }
}

class RouteSpec
{
    public constructor(
        public readonly Method: string,
        public readonly Suffix: string,
        public readonly Service: string,
        public readonly Body?: unknown)
    {
    }
}

describe('TenantApiEndpoint identity-admin routes', () =>
{
    const Grant = { subject: 's1', role: 'admin', resourceKind: 'graph', resourcePath: '/g' }
    const Account = { email: 'a@b.c', principalId: 'p1', password: 'pw' }
    const Config = { packId: 'local', delegationDepth: 'one' }
    const Model = { roles: [] }
    const IssueBody = { principalId: 'svc', scopes: ['read'], expiresInSeconds: 60 }
    const Routes: RouteSpec[] = [
        new RouteSpec('GET', 'admin/tokens', 'AdminListTokens'),
        new RouteSpec('POST', 'admin/tokens', 'AdminIssueToken', IssueBody),
        new RouteSpec('DELETE', 'admin/tokens', 'AdminRevokeToken', { tokenRef: 'r' }),
        new RouteSpec('GET', 'admin/snapshot', 'AdminSnapshot'),
        new RouteSpec('GET', 'admin/config', 'AdminGetConfig'),
        new RouteSpec('GET', 'admin/security-model', 'AdminGetSecurityModel'),
        new RouteSpec('POST', 'admin/accounts', 'AdminCreateAccount', Account),
        new RouteSpec('DELETE', 'admin/accounts/user%2F1', 'AdminDisableAccount'),
        new RouteSpec('POST', 'admin/grants', 'AdminGrantRole', Grant),
        new RouteSpec('DELETE', 'admin/grants', 'AdminRevokeRole', Grant),
        new RouteSpec('PUT', 'admin/security-model', 'AdminSetSecurityModel', { securityModel: Model }),
        new RouteSpec('PUT', 'admin/config', 'AdminSetConfig', Config),
        new RouteSpec('POST', 'maker-token', 'AdminIssueMakerToken'),
        new RouteSpec('POST', 'app-reader-grant', 'AdminGrantAppReader'),
    ]
    let service: FakeService
    let endpoint: TenantApiEndpoint

    beforeEach(() =>
    {
        service = new FakeService([Fixtures.Env('a-env', Fixtures.TenantA), Fixtures.Env('b-env', Fixtures.TenantB)])
        endpoint = new TenantApiEndpoint(service as unknown as IEnvironmentService, Fixtures.Directory(), undefined as never, undefined as never, undefined as never)
    })

    class Driver
    {
        public static async Send(req: IncomingMessage, path: string, tenant: string): Promise<ResRecorder>
        {
            const res = new ResRecorder()
            assert.equal(await endpoint.Handle(req, res as unknown as ServerResponse, path, Fixtures.Session(tenant)), true)
            return res
        }
    }

    for (const r of Routes)
    {
        it(`${r.Method} ${r.Suffix} calls ${r.Service} for the owning tenant`, async () =>
        {
            const res = await Driver.Send(Fixtures.Req(r.Method, r.Body), Fixtures.Base + 'a-env/' + r.Suffix, Fixtures.TenantA)
            assert.ok(res.status === 200 || res.status === 201, `status ${res.status}`)
            assert.equal(service.Calls.length, 1)
            assert.equal(service.Calls[0]!.method, r.Service)
            assert.equal(service.Calls[0]!.args[0], 'a-env')
        })

        it(`${r.Method} ${r.Suffix} 404s a cross-tenant env and never calls the service`, async () =>
        {
            const res = await Driver.Send(Fixtures.Req(r.Method, r.Body), Fixtures.Base + 'b-env/' + r.Suffix, Fixtures.TenantA)
            assert.equal(res.status, 404)
            assert.deepEqual(res.Json(), { error: 'Not found' })
            const unknown = await Driver.Send(Fixtures.Req(r.Method, r.Body), Fixtures.Base + 'nope/' + r.Suffix, Fixtures.TenantA)
            assert.equal(unknown.status, 404)
            assert.equal(service.Calls.length, 0)
        })
    }

    it('passes the decoded principalId, grant mutation, and returned DTOs through', async () =>
    {
        await Driver.Send(Fixtures.Req('DELETE'), Fixtures.Base + 'a-env/admin/accounts/user%2F1', Fixtures.TenantA)
        assert.deepEqual(service.Calls[0]!.args, ['a-env', 'user/1'])
        await Driver.Send(Fixtures.Req('DELETE', Grant), Fixtures.Base + 'a-env/admin/grants', Fixtures.TenantA)
        assert.deepEqual(service.Calls[1]!.args, ['a-env', Grant])
        const cfg = await Driver.Send(Fixtures.Req('GET'), Fixtures.Base + 'a-env/admin/config', Fixtures.TenantA)
        assert.deepEqual(cfg.Json(), { packId: 'local' })
        const sm = await Driver.Send(Fixtures.Req('GET'), Fixtures.Base + 'a-env/admin/security-model', Fixtures.TenantA)
        assert.equal(sm.body, 'null')
        const tok = await Driver.Send(Fixtures.Req('POST'), Fixtures.Base + 'a-env/maker-token', Fixtures.TenantA)
        assert.deepEqual(tok.Json(), { token: 'tok', principalId: 'maker', expiresAt: 'x' })
    })

    it('400s a grant body missing subject/role, a bad account, a bad config, and a bad security model', async () =>
    {
        const bad: Array<[string, string, unknown]> = [
            ['POST', 'admin/grants', { subject: 's' }],
            ['DELETE', 'admin/grants', { role: 'r' }],
            ['POST', 'admin/accounts', { email: 'a' }],
            ['PUT', 'admin/config', { packId: 1 }],
            ['PUT', 'admin/security-model', { securityModel: 1 }],
            ['POST', 'admin/grants', [1]],
        ]
        for (const [m, s, b] of bad)
        {
            const res = await Driver.Send(Fixtures.Req(m, b), Fixtures.Base + 'a-env/' + s, Fixtures.TenantA)
            assert.equal(res.status, 400, m + ' ' + s)
            assert.equal(typeof res.Json().error, 'string')
        }
        const malformed = await Driver.Send(Fixtures.Req('POST', undefined, '{bad'), Fixtures.Base + 'a-env/admin/grants', Fixtures.TenantA)
        assert.equal(malformed.status, 400)
        assert.equal(service.Calls.length, 0)
    })

    it('400s a body over the size cap', async () =>
    {
        const big = JSON.stringify({ subject: 's', role: 'r', resourcePath: 'x'.repeat(10000) })
        const res = await Driver.Send(Fixtures.Req('POST', undefined, big), Fixtures.Base + 'a-env/admin/grants', Fixtures.TenantA)
        assert.equal(res.status, 400)
        assert.equal(service.Calls.length, 0)
    })

    it('maps service throws to a fixed generic status and body with no inner text', async () =>
    {
        const secret = 'SECRET-inner-detail 10.0.0.5 password=hunter2'
        const cases: Array<[Error, number]> = [
            [new AdminProxyError(AdminProxyErrorKind.Connect, secret), 503],
            [new AdminProxyError(AdminProxyErrorKind.Rbac, secret), 409],
            [new AdminProxyError(AdminProxyErrorKind.Invalid, secret), 400],
            [new AdminProxyError(AdminProxyErrorKind.Protocol, secret), 500],
            [new Error(secret), 500],
        ]
        for (const [err, status] of cases)
        {
            service.Throw = err
            const res = await Driver.Send(Fixtures.Req('POST', Grant), Fixtures.Base + 'a-env/admin/grants', Fixtures.TenantA)
            assert.equal(res.status, status)
            assert.equal(typeof res.Json().error, 'string')
            assert.doesNotMatch(res.body, /SECRET|10\.0\.0\.5|hunter2/)
        }
    })

    it('maps a wrong-kind environment on maker-token and app-reader-grant to 400 with a fixed body', async () =>
    {
        service.Throw = new EnvironmentNotDevelopmentError('a-env')
        const mt = await Driver.Send(Fixtures.Req('POST'), Fixtures.Base + 'a-env/maker-token', Fixtures.TenantA)
        assert.equal(mt.status, 400)
        assert.equal(typeof mt.Json().error, 'string')
        service.Throw = new EnvironmentNotRuntimeError('a-env')
        const ar = await Driver.Send(Fixtures.Req('POST'), Fixtures.Base + 'a-env/app-reader-grant', Fixtures.TenantA)
        assert.equal(ar.status, 400)
        assert.equal(typeof ar.Json().error, 'string')
        assert.doesNotMatch(ar.body, /a-env/)
    })

    it('GET tokens returns summaries with no token secret field', async () =>
    {
        const res = await Driver.Send(Fixtures.Req('GET'), Fixtures.Base + 'a-env/admin/tokens', Fixtures.TenantA)
        assert.equal(res.status, 200)
        const list = JSON.parse(res.body) as Array<Record<string, unknown>>
        assert.equal(list.length, 1)
        for (const t of list)
        {
            assert.equal('token' in t, false)
        }
    })

    it('POST tokens returns 201, the issued DTO, and Cache-Control: no-store', async () =>
    {
        const res = await Driver.Send(Fixtures.Req('POST', IssueBody), Fixtures.Base + 'a-env/admin/tokens', Fixtures.TenantA)
        assert.equal(res.status, 201)
        assert.equal(res.Json().token, 'secret-tok')
        assert.equal(res.headers['Cache-Control'], 'no-store')
        assert.deepEqual(service.Calls[0]!.args, ['a-env', IssueBody])
    })

    it('POST tokens 400s invalid bodies without calling the service', async () =>
    {
        const bad: unknown[] = [
            { principalId: 'svc', scopes: [] },
            { scopes: ['read'] },
            { principalId: 'svc', scopes: [1] },
            { principalId: 'svc', scopes: [''] },
            { principalId: 'svc', scopes: ['read', '  '] },
            { principalId: 'svc', scopes: ['read'], expiresInSeconds: 0 },
            { principalId: 'svc', scopes: ['read'], expiresInSeconds: 1.5 },
            { principalId: 'svc', scopes: ['read'], expiresInSeconds: 'x' },
        ]
        for (const b of bad)
        {
            const res = await Driver.Send(Fixtures.Req('POST', b), Fixtures.Base + 'a-env/admin/tokens', Fixtures.TenantA)
            assert.equal(res.status, 400)
            assert.equal(typeof res.Json().error, 'string')
        }
        assert.equal(service.Calls.length, 0)
    })

    it('POST tokens accepts null/absent expiresInSeconds', async () =>
    {
        const res = await Driver.Send(Fixtures.Req('POST', { principalId: 'svc', scopes: ['read'], expiresInSeconds: null }), Fixtures.Base + 'a-env/admin/tokens', Fixtures.TenantA)
        assert.equal(res.status, 201)
        const res2 = await Driver.Send(Fixtures.Req('POST', { principalId: 'svc', scopes: ['read'] }), Fixtures.Base + 'a-env/admin/tokens', Fixtures.TenantA)
        assert.equal(res2.status, 201)
    })

    it('DELETE tokens 400s a missing or empty tokenRef', async () =>
    {
        for (const b of [{}, { tokenRef: '' }, { tokenRef: 1 }])
        {
            const res = await Driver.Send(Fixtures.Req('DELETE', b), Fixtures.Base + 'a-env/admin/tokens', Fixtures.TenantA)
            assert.equal(res.status, 400)
        }
        assert.equal(service.Calls.length, 0)
    })

    it('maps a NotFound AdminProxyError on revoke to a generic 404', async () =>
    {
        service.Throw = new AdminProxyError(AdminProxyErrorKind.NotFound, 'SECRET-inner')
        const res = await Driver.Send(Fixtures.Req('DELETE', { tokenRef: 'r' }), Fixtures.Base + 'a-env/admin/tokens', Fixtures.TenantA)
        assert.equal(res.status, 404)
        assert.equal(typeof res.Json().error, 'string')
        assert.doesNotMatch(res.body, /SECRET/)
    })

    it('GET on a tokens sub-path 404s and never lists tokens', async () =>
    {
        const res = await Driver.Send(Fixtures.Req('GET'), Fixtures.Base + 'a-env/admin/tokens/x', Fixtures.TenantA)
        assert.equal(res.status, 404)
        assert.equal(service.Calls.length, 0)
    })

    it('POST tokens trims each scope before issuing', async () =>
    {
        await Driver.Send(Fixtures.Req('POST', { principalId: 'svc', scopes: ['read ', ' write'] }), Fixtures.Base + 'a-env/admin/tokens', Fixtures.TenantA)
        const params = service.Calls[0]!.args[1] as { scopes: string[] }
        assert.deepEqual(params.scopes, ['read', 'write'])
    })

    it('answers other methods on identity-admin paths with 404', async () =>
    {
        const res = await Driver.Send(Fixtures.Req('POST'), Fixtures.Base + 'a-env/admin/snapshot', Fixtures.TenantA)
        assert.equal(res.status, 404)
        assert.equal(service.Calls.length, 0)
    })
})
