import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ControlPlaneHost } from '../control-plane-host.js'
import type { IEnvironmentService, IGraphService } from '../control-plane-host.js'
import { OperatorExistsError, OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSession, type OperatorSummary } from '../operator-identity.js'
import type { PlatformDirectory } from '../platform-directory.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import type { TenantProvisioningService } from '../tenant-provisioning-service.js'
import type { HiveObservationRegistry } from '../hive-observation-record.js'

class RoleOperator implements IOperatorIdentity
{
    public static readonly FullToken = 'full-token'
    public static readonly ReadToken = 'read-token'
    public Created: Array<{ email: string; role: OperatorRole }> = []
    public Revoked: string[] = []

    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        return null
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        if (token === RoleOperator.FullToken)
        {
            return { email: 'f@x.test', principalId: 'f', role: OperatorRole.Full }
        }
        return token === RoleOperator.ReadToken ? { email: 'r@x.test', principalId: 'r', role: OperatorRole.ReadOnly } : null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        return []
    }

    public async CreateOperator(email: string, _password: string, role: OperatorRole): Promise<void>
    {
        if (this.Created.some(c => c.email === email))
        {
            throw new OperatorExistsError()
        }
        this.Created.push({ email, role })
    }

    public async Revoke(token: string): Promise<void>
    {
        this.Revoked.push(token)
    }
}

class RbacFixture
{
    public static readonly Loopback = '127.0.0.1'
    public static readonly Forbidden = 403
    public static readonly Unauthorized = 401
    public static readonly NoToken = 'no-such-token'
    public static readonly Ok = 200
    public static readonly Created = 201
    public static readonly BadRequest = 400
    public static readonly TempPrefix = 'cp-rbac-'
    public static readonly Operators = '/api/operators'
    public static readonly Clients = '/api/clients'
    public static readonly Provision = '/api/provision'
    public static readonly Environments = '/api/environments'
    public static readonly Logout = '/api/logout'
    public static readonly CookiePrefix = 'cp_session='
    public static readonly Password = 'pw-secret-123'
    public static readonly NewBody = JSON.stringify({ email: 'new@x.test', password: RbacFixture.Password, role: 'readonly' })
    public static readonly Conflict = 409
    public static readonly ShortBody = JSON.stringify({ email: 'a@x.test', password: 'short', role: 'full' })
    public static readonly BadEmailBody = JSON.stringify({ email: 'not-an-email', password: RbacFixture.Password, role: 'full' })
    public static readonly BadRoleBody = JSON.stringify({ email: 'a@x.test', password: 'p', role: 'god' })
    public static readonly Manifests = '/api/manifests'
    public static readonly ManifestWithdrawn = '/api/manifests/1.0.0/withdrawn'
    public static readonly TenantGating = '/api/tenants/t1/gating'
    public static readonly TenantUngate = '/api/tenants/t1/gating/1.0.0'
    public static readonly Post = 'POST'
    public static readonly Delete = 'DELETE'
    public static readonly PublishBody = JSON.stringify({ version: '1.0.0', image: 'img:1' })
    public static readonly GateBody = JSON.stringify({ version: '1.0.0' })
    public static readonly EmptyBody = ''

    public static Send(host: ControlPlaneHost, method: string, path: string, token: string, body: string): Promise<{ status: number; text: string }>
    {
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const headers = { cookie: RbacFixture.CookiePrefix + token, 'content-type': 'application/json' }
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                let text = ''
                res.on('data', (c: Buffer) => { text += c.toString() })
                res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
            })
            req.on('error', reject)
            req.end(method === 'GET' ? undefined : body)
        })
    }
}

describe('ControlPlaneHost operator RBAC', () =>
{
    let root: string
    let host: ControlPlaneHost
    let operator: RoleOperator

    beforeEach(async () =>
    {
        root = mkdtempSync(join(tmpdir(), RbacFixture.TempPrefix))
        operator = new RoleOperator()
        const service = { ListReconciled: async () => [] } as unknown as IEnvironmentService
        host = new ControlPlaneHost(service, {} as IGraphService, root, operator, false,
            {} as PlatformDirectory, {} as PlatformDeploymentRegistry, {} as TenantProvisioningService, {} as HiveObservationRegistry)
        await host.Listen(0, RbacFixture.Loopback)
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(root, { recursive: true, force: true })
    })

    it('403s a ReadOnly operator on mutating routes', async () =>
    {
        for (const path of [RbacFixture.Clients, RbacFixture.Operators])
        {
            const r = await RbacFixture.Send(host, 'POST', path, RoleOperator.ReadToken, RbacFixture.NewBody)
            assert.equal(r.status, RbacFixture.Forbidden, path)
        }
        assert.equal(operator.Created.length, 0)
    })

    it('403s a ReadOnly operator and 401s an unauthenticated caller on POST /api/provision, with zero writes', async () =>
    {
        const forbidden = await RbacFixture.Send(host, RbacFixture.Post, RbacFixture.Provision, RoleOperator.ReadToken, RbacFixture.NewBody)
        assert.equal(forbidden.status, RbacFixture.Forbidden)
        const anonymous = await RbacFixture.Send(host, RbacFixture.Post, RbacFixture.Provision, RbacFixture.NoToken, RbacFixture.NewBody)
        assert.equal(anonymous.status, RbacFixture.Unauthorized)
        assert.equal(operator.Created.length, 0)
    })

    it('403s a ReadOnly operator on the registry-write routes', async () =>
    {
        const cases: Array<{ method: string; path: string; body: string }> = [
            { method: RbacFixture.Post, path: RbacFixture.Manifests, body: RbacFixture.PublishBody },
            { method: RbacFixture.Post, path: RbacFixture.TenantGating, body: RbacFixture.GateBody },
            { method: RbacFixture.Delete, path: RbacFixture.TenantUngate, body: RbacFixture.EmptyBody },
            { method: RbacFixture.Post, path: RbacFixture.ManifestWithdrawn, body: RbacFixture.EmptyBody },
            { method: RbacFixture.Delete, path: RbacFixture.ManifestWithdrawn, body: RbacFixture.EmptyBody },
        ]
        for (const c of cases)
        {
            const r = await RbacFixture.Send(host, c.method, c.path, RoleOperator.ReadToken, c.body)
            assert.equal(r.status, RbacFixture.Forbidden, c.method + ' ' + c.path)
        }
    })

    it('lets a ReadOnly operator GET a resource and log out', async () =>
    {
        assert.equal((await RbacFixture.Send(host, 'GET', RbacFixture.Environments, RoleOperator.ReadToken, '')).status, RbacFixture.Ok)
        assert.equal((await RbacFixture.Send(host, 'POST', RbacFixture.Logout, RoleOperator.ReadToken, '{}')).status, RbacFixture.Ok)
        assert.deepEqual(operator.Revoked, [RoleOperator.ReadToken])
    })

    it('lets a Full operator create an operator without echoing the password', async () =>
    {
        const r = await RbacFixture.Send(host, 'POST', RbacFixture.Operators, RoleOperator.FullToken, RbacFixture.NewBody)
        assert.equal(r.status, RbacFixture.Created)
        assert.ok(!r.text.includes(RbacFixture.Password))
        assert.deepEqual(operator.Created, [{ email: 'new@x.test', role: OperatorRole.ReadOnly }])
    })

    it('rejects a malformed create-operator body', async () =>
    {
        const r = await RbacFixture.Send(host, 'POST', RbacFixture.Operators, RoleOperator.FullToken, RbacFixture.BadRoleBody)
        assert.equal(r.status, RbacFixture.BadRequest)
    })

    it('409s a duplicate email', async () =>
    {
        await RbacFixture.Send(host, 'POST', RbacFixture.Operators, RoleOperator.FullToken, RbacFixture.NewBody)
        const r = await RbacFixture.Send(host, 'POST', RbacFixture.Operators, RoleOperator.FullToken, RbacFixture.NewBody)
        assert.equal(r.status, RbacFixture.Conflict)
        assert.ok(!r.text.includes(RbacFixture.Password))
    })

    it('400s a too-short password and a malformed email', async () =>
    {
        assert.equal((await RbacFixture.Send(host, 'POST', RbacFixture.Operators, RoleOperator.FullToken, RbacFixture.ShortBody)).status, RbacFixture.BadRequest)
        assert.equal((await RbacFixture.Send(host, 'POST', RbacFixture.Operators, RoleOperator.FullToken, RbacFixture.BadEmailBody)).status, RbacFixture.BadRequest)
        assert.equal(operator.Created.length, 0)
    })
})
