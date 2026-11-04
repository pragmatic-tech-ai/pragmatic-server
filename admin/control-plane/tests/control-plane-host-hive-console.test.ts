import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { RolloutFixture } from './rollout-fixture.js'
import { ControlPlaneHost, type IEnvironmentService, type IGraphService } from '../control-plane-host.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSession, type OperatorSummary } from '../operator-identity.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { OperatorAuthorization } from '../operator-authorization.js'
import { AuditRegistry } from '../audit-record.js'
import { PlatformDirectory } from '../platform-directory.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'

type Reply = { status: number; body: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly FullToken = 'full-token'
    public static readonly ReadOnlyToken = 'readonly-token'

    public async Authenticate(_email: string, _password: string): Promise<OperatorSession | null>
    {
        return null
    }

    public async ValidateToken(token: string): Promise<OperatorPrincipal | null>
    {
        if (token === FakeOperator.FullToken)
        {
            return { email: 'op@example.com', principalId: 'p1', role: OperatorRole.Full }
        }
        return token === FakeOperator.ReadOnlyToken ? { email: 'ro@example.com', principalId: 'p2', role: OperatorRole.ReadOnly } : null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]> { return [] }
    public async SetOperatorRole(_e: string, _r: OperatorRole, _a: string): Promise<void> { }
    public async ChangeOwnPassword(_p: string, _c: string, _n: string): Promise<null> { return null }
    public async ResetOperatorPassword(_e: string): Promise<string> { return '' }
    public async SetOperatorDisabled(_e: string, _d: boolean, _a: string): Promise<void> { }
    public async RevokeOperatorSessions(_e: string): Promise<void> { }
    public async CreateOperator(_e: string, _p: string, _r: OperatorRole): Promise<void> { }
    public async Revoke(_t: string): Promise<void> { }
}

class Harness
{
    public static readonly Good = { baseDomain: 'localtest.me', tls: { source: 'development' } }

    public static Put(host: ControlPlaneHost, path: string, body: unknown, token: string | null = FakeOperator.FullToken, extra: Record<string, string> = {}): Promise<Reply>
    {
        const payload = typeof body === 'string' ? body : JSON.stringify(body)
        const headers: Record<string, string> = { 'content-type': 'application/json', ...extra }
        if (token !== null)
        {
            headers.cookie = 'cp_session=' + token
        }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method: 'PUT', path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end(payload)
        })
    }
}

describe('ControlPlaneHost hive console settings', () =>
{
    let host: ControlPlaneHost
    let parent: string
    let directory: PlatformDirectory
    let audit: AuditRegistry

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-hive-console-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'acme', displayName: 'Acme' })
        await directory.CreateTenant({ id: 't1', clientId: 'acme', displayName: 'T' })
        const spec = { cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } }
        await directory.CreateHive({ id: 'h1', tenantId: 't1', displayName: 'H1', ...spec })
        await directory.CreateHive({ id: 'h2', tenantId: 't1', displayName: 'H2', ...spec })
        audit = new AuditRegistry(join(parent, 'audit.json'))
        await audit.Load()
        const deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, deployments,
            new FakeProvisioning(directory).AsService(), RolloutFixture.Observations(parent),
            undefined, undefined, undefined, undefined, undefined, undefined, new OperatorAuthorization(), audit)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('PUT stores the console setting', async () =>
    {
        const r = await Harness.Put(host, '/api/hives/h1/console', Harness.Good)
        assert.equal(r.status, 200)
        const hive = JSON.parse(r.body) as HiveRecord
        assert.equal(hive.id, 'h1')
        assert.equal(hive.console?.baseDomain, 'localtest.me')
        assert.equal(directory.GetHive('h1')?.console?.tls.source, 'development')
    })

    it('PUT with a bad body is 400 with a plain sentence', async () =>
    {
        for (const body of [{ baseDomain: 'localhost', tls: { source: 'development' } }, { baseDomain: 'localtest.me', tls: { source: 'nope' } }])
        {
            const r = await Harness.Put(host, '/api/hives/h1/console', body)
            assert.equal(r.status, 400)
            assert.match(JSON.parse(r.body).error as string, /^[A-Z].*\.$/)
        }
        assert.equal((await Harness.Put(host, '/api/hives/h1/console', '{nope')).status, 400)
        assert.equal(directory.GetHive('h1')?.console, undefined)
    })

    it('PUT for an unknown hive is 404', async () =>
    {
        assert.equal((await Harness.Put(host, '/api/hives/nope/console', Harness.Good)).status, 404)
    })

    it('PUT for a tenant that already has a console is 409', async () =>
    {
        assert.equal((await Harness.Put(host, '/api/hives/h1/console', Harness.Good)).status, 200)
        const r = await Harness.Put(host, '/api/hives/h2/console', Harness.Good)
        assert.equal(r.status, 409)
        assert.match(JSON.parse(r.body).error as string, /already runs its console in hive h1/)
    })

    it('a read-only operator gets 403', async () =>
    {
        const r = await Harness.Put(host, '/api/hives/h1/console', Harness.Good, FakeOperator.ReadOnlyToken)
        assert.equal(r.status, 403)
        assert.equal(directory.GetHive('h1')?.console, undefined)
    })

    it('an unauthenticated PUT is 401 and changes nothing', async () =>
    {
        assert.equal((await Harness.Put(host, '/api/hives/h1/console', Harness.Good, null)).status, 401)
        assert.equal(directory.GetHive('h1')?.console, undefined)
    })

    it('a cross-origin PUT is 403 and changes nothing', async () =>
    {
        const r = await Harness.Put(host, '/api/hives/h1/console', Harness.Good, FakeOperator.FullToken, { origin: 'http://evil.example' })
        assert.equal(r.status, 403)
        assert.equal(directory.GetHive('h1')?.console, undefined)
    })

    it('an oversized body is 413', async () =>
    {
        const r = await Harness.Put(host, '/api/hives/h1/console', { ...Harness.Good, baseDomain: 'a'.repeat(10000) })
        assert.equal(r.status, 413)
        assert.equal(directory.GetHive('h1')?.console, undefined)
    })

    it('a tenant whose default console host is not a DNS name is 400', async () =>
    {
        await directory.CreateTenant({ id: 'Acme_1', clientId: 'acme', displayName: 'Odd' })
        await directory.CreateHive({ id: 'h3', tenantId: 'Acme_1', displayName: 'H3', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        const r = await Harness.Put(host, '/api/hives/h3/console', Harness.Good)
        assert.equal(r.status, 400)
        assert.match(JSON.parse(r.body).error as string, /^[A-Z].*\.$/)
    })

    it('the PUT is audited with the operator and the real status', async () =>
    {
        await Harness.Put(host, '/api/hives/h1/console', Harness.Good)
        await Harness.Put(host, '/api/hives/h2/console', Harness.Good)
        const entries = audit.Recent(10).filter(e => e.path.endsWith('/console'))
        assert.deepEqual(entries.map(e => [e.actor, e.method, e.path, e.status]).sort(),
            [['op@example.com', 'PUT', '/api/hives/h1/console', 200], ['op@example.com', 'PUT', '/api/hives/h2/console', 409]])
    })
})
