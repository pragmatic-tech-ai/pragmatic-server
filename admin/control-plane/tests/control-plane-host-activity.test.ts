import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSession, type OperatorSummary } from '../operator-identity.js'
import { OperatorAuthorization } from '../operator-authorization.js'
import { AuditRegistry, type AuditRecord } from '../audit-record.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { RolloutFixture } from './rollout-fixture.js'

type Reply = { status: number; body: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly Token = 'valid-token'

    public Role: OperatorRole = OperatorRole.Full

    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        return { token: FakeOperator.Token, expiresAt: new Date(Date.now() + 3600000) }
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        return token === FakeOperator.Token ? { email: 'op@example.com', principalId: 'p1', role: this.Role } : null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        return []
    }

    public async SetOperatorRole(_email: string, _role: OperatorRole, _actorPrincipalId: string): Promise<void>
    {
    }

    public async ResetOperatorPassword(_email: string): Promise<string>
    {
        return ''
    }

    public async SetOperatorDisabled(_email: string, _disabled: boolean, _actorPrincipalId: string): Promise<void>
    {
    }

    public async RevokeOperatorSessions(_email: string): Promise<void>
    {
    }

    public async CreateOperator(_email: string, _password: string, _role: OperatorRole): Promise<void>
    {
    }

    public async Revoke(_token: string): Promise<void>
    {
    }
}

class ThrowingAudit extends AuditRegistry
{
    public override async Append(_entry: Omit<AuditRecord, 'id'>): Promise<void>
    {
        throw new Error('disk full')
    }
}

class Harness
{
    public static Send(host: ControlPlaneHost, method: string, path: string, body?: unknown, authed: boolean = true): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (authed)
        {
            headers.cookie = 'cp_session=' + FakeOperator.Token
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
            req.end(body === undefined ? undefined : JSON.stringify(body))
        })
    }

    public static async Build(parent: string, operator: FakeOperator, audit: AuditRegistry): Promise<ControlPlaneHost>
    {
        const root = join(parent, 'static')
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        const deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        const host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, operator, false, directory, deployments, new FakeProvisioning(directory).AsService(), RolloutFixture.Observations(parent),
            undefined, undefined, undefined, undefined, undefined, undefined, new OperatorAuthorization(), audit)
        await host.Listen(0, '127.0.0.1')
        return host
    }
}

describe('ControlPlaneHost operator action audit', () =>
{
    let host: ControlPlaneHost
    let parent: string
    let operator: FakeOperator
    let audit: AuditRegistry

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-activity-'))
        operator = new FakeOperator()
        audit = new AuditRegistry(join(parent, 'audit.json'))
        await audit.Load()
        host = await Harness.Build(parent, operator, audit)
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('records one entry for an authorized mutation with the real status', async () =>
    {
        const res = await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        assert.equal(res.status, 201)
        const recent = audit.Recent(10)
        assert.equal(recent.length, 1)
        assert.equal(recent[0]!.actor, 'op@example.com')
        assert.equal(recent[0]!.method, 'POST')
        assert.equal(recent[0]!.path, '/api/manifests')
        assert.equal(recent[0]!.status, 201)
    })

    it('records the handler rejection status', async () =>
    {
        const res = await Harness.Send(host, 'POST', '/api/manifests', {})
        assert.equal(res.status, 400)
        const recent = audit.Recent(10)
        assert.equal(recent.length, 1)
        assert.equal(recent[0]!.status, 400)
    })

    it('does not audit GET reads', async () =>
    {
        const res = await Harness.Send(host, 'GET', '/api/manifests')
        assert.equal(res.status, 200)
        assert.equal(audit.Recent(10).length, 0)
    })

    it('records a 403 for a ReadOnly-denied mutation', async () =>
    {
        operator.Role = OperatorRole.ReadOnly
        const res = await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        assert.equal(res.status, 403)
        const recent = audit.Recent(10)
        assert.equal(recent.length, 1)
        assert.equal(recent[0]!.actor, 'op@example.com')
        assert.equal(recent[0]!.status, 403)
    })

    it('records a 401 as (anonymous) for an unauthenticated mutation', async () =>
    {
        const res = await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' }, false)
        assert.equal(res.status, 401)
        const recent = audit.Recent(10)
        assert.equal(recent.length, 1)
        assert.equal(recent[0]!.actor, '(anonymous)')
        assert.equal(recent[0]!.status, 401)
    })

    it('serves GET /api/activity newest-first and honors limit', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        await new Promise(r => setTimeout(r, 5))
        await Harness.Send(host, 'POST', '/api/manifests', { version: '2.0.0', image: 'img:2' })
        await new Promise(r => setTimeout(r, 5))
        await Harness.Send(host, 'POST', '/api/manifests', {})
        const res = await Harness.Send(host, 'GET', '/api/activity?limit=2')
        assert.equal(res.status, 200)
        const rows = JSON.parse(res.body) as AuditRecord[]
        assert.equal(rows.length, 2)
        assert.equal(rows[0]!.status, 400)
        assert.equal(rows[1]!.status, 201)
        assert.ok(rows[0]!.at >= rows[1]!.at)
    })

    it('stores no query string and no body field', async () =>
    {
        await Harness.Send(host, 'POST', '/api/manifests?token=s3cret', { version: '1.0.0', image: 'img:1', notes: 'hunter2' })
        const entry = audit.Recent(1)[0]!
        assert.deepEqual(Object.keys(entry).sort(), ['actor', 'at', 'id', 'method', 'path', 'status'])
        assert.ok(!entry.path.includes('?'))
        assert.ok(!JSON.stringify(entry).includes('hunter2'))
    })

    it('swallows an audit failure without changing the response', async () =>
    {
        await host.Close()
        const throwing = new ThrowingAudit(join(parent, 'audit-throw.json'))
        host = await Harness.Build(join(parent, 'b'), operator, throwing)
        const res = await Harness.Send(host, 'POST', '/api/manifests', { version: '1.0.0', image: 'img:1' })
        assert.equal(res.status, 201)
    })
})
