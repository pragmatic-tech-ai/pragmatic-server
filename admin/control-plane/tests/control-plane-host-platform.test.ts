import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { RolloutFixture } from './rollout-fixture.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSession, type OperatorSummary } from '../operator-identity.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { InvalidTenantIdError } from '../idp-service.js'
import { PlatformDirectory, RecordExistsError } from '../platform-directory.js'

type Reply = { status: number; body: string; cacheControl?: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly Token = 'valid-token'

    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        return { token: FakeOperator.Token, expiresAt: new Date(Date.now() + 3600000) }
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        return token === FakeOperator.Token ? { email: 'op@example.com', principalId: 'p1', role: OperatorRole.Full } : null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        return []
    }

    public async CreateOperator(_email: string, _password: string, _role: OperatorRole): Promise<void>
    {
    }

    public async Revoke(_token: string): Promise<void>
    {
    }
}

class Harness
{
    public static readonly AuthCookie = 'cp_session=valid-token'

    public static ProvisionBody(): { client: Record<string, unknown>; tenant: Record<string, unknown>; hive: Record<string, unknown> }
    {
        return {
            client: { id: 'acme', displayName: 'Acme' },
            tenant: { id: 't1', displayName: 'T', ownerEmail: 'o@x.test' },
            hive: { id: 'h1', displayName: 'H', cluster: { backend: 'local', mode: 'provision' }, registry: { mode: 'provision' } }
        }
    }

    public static Send(host: ControlPlaneHost, method: string, path: string, body?: unknown, authed: boolean = true): Promise<Reply>
    {
        const text = body === undefined ? undefined : JSON.stringify(body)
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (authed)
        {
            headers.cookie = Harness.AuthCookie
        }
        if (text !== undefined)
        {
            headers['content-length'] = String(Buffer.byteLength(text))
        }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, cacheControl: res.headers['cache-control'], body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end(text)
        })
    }
}

describe('ControlPlaneHost platform routes', () =>
{
    let host: ControlPlaneHost
    let fake: FakeProvisioning
    let parent: string

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-platform-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        const factory = new HiveOrchestratorFactory()
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, await RolloutFixture.Create(parent, directory, factory), (fake = new FakeProvisioning(directory)).AsService(), RolloutFixture.Observations(parent))
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('challenges an unauthenticated clients request with 401', async () =>
    {
        assert.equal((await Harness.Send(host, 'GET', '/api/clients', undefined, false)).status, 401)
    })

    it('creates a client then lists it', async () =>
    {
        const created = await Harness.Send(host, 'POST', '/api/clients', { id: 'acme', displayName: 'Acme' })
        assert.equal(created.status, 201)
        const list = await Harness.Send(host, 'GET', '/api/clients')
        assert.equal(list.status, 200)
        const arr = JSON.parse(list.body)
        assert.equal(arr.length, 1)
        assert.equal(arr[0].id, 'acme')
        assert.equal((await Harness.Send(host, 'POST', '/api/clients', { id: 'acme', displayName: 'Dup' })).status, 409)
    })

    it('provisions a tenant and reveals the one-time Owner password with no-store', async () =>
    {
        await Harness.Send(host, 'POST', '/api/clients', { id: 'acme', displayName: 'Acme' })
        const r = await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })
        assert.equal(r.status, 201)
        assert.equal(r.cacheControl, 'no-store')
        const body = JSON.parse(r.body)
        assert.equal(body.id, 't1')
        assert.deepEqual(body.owner, { email: 'o@x.test', principalId: 'owner', password: FakeProvisioning.Password })
    })

    it('rejects a tenant create without ownerEmail or with a reserved _ id', async () =>
    {
        await Harness.Send(host, 'POST', '/api/clients', { id: 'acme', displayName: 'Acme' })
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T' })).status, 400)
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: '' })).status, 400)
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: '_sys', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })).status, 400)
        assert.equal(fake.Calls.length, 0)
    })

    it('maps provisioning failures to 400 and 409', async () =>
    {
        await Harness.Send(host, 'POST', '/api/clients', { id: 'acme', displayName: 'Acme' })
        const body = { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' }
        fake.FailWith = new InvalidTenantIdError('bad id')
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', body)).status, 400)
        fake.FailWith = new RecordExistsError('t1')
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', body)).status, 409)
    })

    it('maps a cascade violation to 409 and an unknown parent to 404', async () =>
    {
        await Harness.Send(host, 'POST', '/api/clients', { id: 'acme', displayName: 'Acme' })
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })).status, 201)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/clients/acme')).status, 409)
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: 't2', clientId: 'nope', displayName: 'T', ownerEmail: 'o@x.test' })).status, 404)
        const hive = { id: 'h1', tenantId: 't1', displayName: 'H', cluster: { backend: 'local', mode: 'provision' }, registry: { mode: 'provision' } }
        assert.equal((await Harness.Send(host, 'POST', '/api/hives', hive)).status, 201)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/tenants/t1')).status, 409)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/h1')).status, 200)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/h1')).status, 200)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/h1')).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/hives', { ...hive, cluster: { backend: 'bogus', mode: 'provision' } })).status, 400)
    })

    it('POST /api/provision as Full operator -> 201 with records and both secrets', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/provision', Harness.ProvisionBody())
        assert.equal(r.status, 201)
        assert.equal(r.cacheControl, 'no-store')
        const body = JSON.parse(r.body)
        assert.equal(body.client.id, 'acme')
        assert.equal(body.tenant.id, 't1')
        assert.equal(body.hive.id, 'h1')
        assert.ok(body.secrets.ownerPassword.length > 0)
        assert.ok(body.secrets.agentToken.length > 0)
        const fetched = await Harness.Send(host, 'GET', '/api/tenants/t1')
        assert.equal(fetched.status, 200)
        assert.ok(!fetched.body.includes(body.secrets.ownerPassword))
        assert.ok(!fetched.body.includes(body.secrets.agentToken))
    })

    it('POST /api/provision with a duplicate client id -> 409 and no partial tenant/hive', async () =>
    {
        await Harness.Send(host, 'POST', '/api/clients', { id: 'acme', displayName: 'Acme' })
        const r = await Harness.Send(host, 'POST', '/api/provision', Harness.ProvisionBody())
        assert.equal(r.status, 409)
        assert.equal(JSON.parse((await Harness.Send(host, 'GET', '/api/tenants')).body).length, 0)
        assert.equal(JSON.parse((await Harness.Send(host, 'GET', '/api/hives')).body).length, 0)
    })

    it('POST /api/provision with an invalid cluster -> 400 and zero writes', async () =>
    {
        const bad = Harness.ProvisionBody()
        bad.hive.cluster = { backend: 'bogus', mode: 'provision' }
        const r = await Harness.Send(host, 'POST', '/api/provision', bad)
        assert.equal(r.status, 400)
        for (const path of ['/api/clients', '/api/tenants', '/api/hives'])
        {
            assert.equal(JSON.parse((await Harness.Send(host, 'GET', path)).body).length, 0, path)
        }
    })
})
