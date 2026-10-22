import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { IOperatorIdentity, OperatorPrincipal, OperatorSession } from '../operator-identity.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'

type Reply = { status: number; body: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly Token = 'valid-token'

    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        return { token: FakeOperator.Token, expiresAt: new Date(Date.now() + 3600000) }
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        return token === FakeOperator.Token ? { email: 'op@example.com', principalId: 'p1' } : null
    }

    public async Revoke(_token: string): Promise<void>
    {
    }
}

class Harness
{
    public static readonly AuthCookie = 'cp_session=valid-token'

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
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end(text)
        })
    }
}

describe('ControlPlaneHost platform routes', () =>
{
    let host: ControlPlaneHost
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
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, new HiveOrchestratorFactory())
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

    it('maps a cascade violation to 409 and an unknown parent to 404', async () =>
    {
        await Harness.Send(host, 'POST', '/api/clients', { id: 'acme', displayName: 'Acme' })
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T' })).status, 201)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/clients/acme')).status, 409)
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: 't2', clientId: 'nope', displayName: 'T' })).status, 404)
        const hive = { id: 'h1', tenantId: 't1', displayName: 'H', cluster: { backend: 'local', mode: 'provision' }, registry: { mode: 'provision' } }
        assert.equal((await Harness.Send(host, 'POST', '/api/hives', hive)).status, 201)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/tenants/t1')).status, 409)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/h1')).status, 200)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/h1')).status, 200)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/h1')).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/hives', { ...hive, cluster: { backend: 'bogus', mode: 'provision' } })).status, 400)
    })
})
