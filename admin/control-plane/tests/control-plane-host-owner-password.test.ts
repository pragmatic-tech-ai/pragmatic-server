import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { RolloutFixture } from './rollout-fixture.js'
import { ControlPlaneHost } from '../control-plane-host.js'
import { type IEnvironmentService, type IGraphService, HiveOrchestratorFactory, IdpAdminError, IdpAdminTransportError } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSummary } from '../operator-identity.js'
import { InMemoryAuditRepository } from '@pragmatic-tech-ai/pragmatic-app-host'
import { HostSessions } from './host-sessions.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { PlatformDirectory } from '../platform-directory.js'
import { IdpUnreachableError, OwnerAccountMissingError, OwnerIdpRefusedError, OwnerNotRecordedError, OwnerResetInProgressError, TenantIdpMissingError } from '../tenant-provisioning-service.js'

type Reply = { status: number; body: string; cacheControl?: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly FullToken = 'full-token'
    public static readonly ReadOnlyToken = 'readonly-token'
    public static readonly Full: OperatorPrincipal = { email: 'op@example.com', principalId: 'p1', role: OperatorRole.Full }
    public static readonly ReadOnly: OperatorPrincipal = { email: 'ro@example.com', principalId: 'p2', role: OperatorRole.ReadOnly }

    public async Verify(_email: string, _password: string): Promise<OperatorPrincipal | null> { return null }

    public async PrincipalOf(principalId: string): Promise<OperatorPrincipal | null>
    {
        return [FakeOperator.Full, FakeOperator.ReadOnly].find(p => p.principalId === principalId) ?? null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]> { return [] }
    public async SetOperatorRole(_e: string, _r: OperatorRole, _a: string): Promise<void> { }
    public async ChangeOwnPassword(_p: string, _c: string, _n: string): Promise<boolean> { return false }
    public async ResetOperatorPassword(_e: string): Promise<string> { return '' }
    public async SetOperatorDisabled(_e: string, _d: boolean, _a: string): Promise<void> { }
    public async RevokeOperatorSessions(_e: string): Promise<void> { }
    public async CreateOperator(_e: string, _p: string, _r: OperatorRole): Promise<void> { }
}

class Harness
{
    public static Send(host: ControlPlaneHost, method: string, path: string, token: string = FakeOperator.FullToken): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json', cookie: 'cp_session=' + token }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, cacheControl: res.headers['cache-control'] as string | undefined, body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end()
        })
    }
}

describe('ControlPlaneHost tenant Owner password reset', () =>
{
    const ResetPath = '/api/tenants/t1/owner-password'
    let host: ControlPlaneHost
    let parent: string
    let provisioning: FakeProvisioning
    let audit: InMemoryAuditRepository
    let logged: string[]
    let originalError: typeof console.error

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-owner-reset-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'acme', displayName: 'Acme' })
        provisioning = new FakeProvisioning(directory)
        await provisioning.Provision({ id: 't1', clientId: 'acme', displayName: 'T1', ownerEmail: 'owner@acme.test' })
        audit = new InMemoryAuditRepository()
        const deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        const sessions = await HostSessions.With(FakeOperator.FullToken, FakeOperator.Full)
        await sessions.Seed(FakeOperator.ReadOnlyToken, FakeOperator.ReadOnly)
        host = new ControlPlaneHost({ Service: {} as IEnvironmentService, Graphs: {} as IGraphService, PortalRoot: root, Operator: new FakeOperator(), Sessions: sessions.Sessions,
            Directory: directory, Deployments: deployments, Provisioning: provisioning.AsService(), Observations: RolloutFixture.Observations(parent), Audit: audit })
        await host.Listen(0, '127.0.0.1')
        logged = []
        originalError = console.error
        console.error = (...args: unknown[]) => { logged.push(args.map(a => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' ')) }
    })

    afterEach(async () =>
    {
        console.error = originalError
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('resets the Owner of the tenant and returns email + password once, no-store; the audit and logs never hold the password', async () =>
    {
        const r = await Harness.Send(host, 'POST', ResetPath)
        assert.equal(r.status, 200)
        assert.equal(r.cacheControl, 'no-store')
        const body = JSON.parse(r.body) as { ownerEmail: string; ownerPassword: string }
        assert.equal(body.ownerEmail, 'owner@acme.test')
        assert.equal(body.ownerPassword, FakeProvisioning.ResetPassword)
        assert.deepEqual(provisioning.Resets, ['t1'])
        // The activity log is the host's audit trail now: an entry's Target is the path, its Action the method.
        const entry = (await audit.Recent(10)).find(e => e.Target === ResetPath)
        assert.equal(entry?.Action, 'POST')
        assert.equal(entry?.Status, 200)
        assert.ok(!JSON.stringify(await audit.Recent(100)).includes(FakeProvisioning.ResetPassword))
        assert.ok(!logged.join('\n').includes(FakeProvisioning.ResetPassword))
    })

    it('a reset whose session revoke failed still returns the password, with sessionsRevoked false and the warning', async () =>
    {
        provisioning.ResetWarning = "The new password is set, but the Owner's existing sessions could not be ended."
        const r = await Harness.Send(host, 'POST', ResetPath)
        assert.equal(r.status, 200)
        const body = JSON.parse(r.body) as { ownerPassword: string; sessionsRevoked: boolean; warning?: string }
        assert.equal(body.ownerPassword, FakeProvisioning.ResetPassword)
        assert.equal(body.sessionsRevoked, false)
        assert.match(body.warning ?? '', /could not be ended/)
    })

    it('an unknown tenant -> 404', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants/nope/owner-password')).status, 404)
        assert.deepEqual(provisioning.Resets, [])
    })

    it('no Owner recorded, no IdP, IdP without the account, IdP refused -> 409 with the reason; IdP unreachable -> 503 with the reason', async () =>
    {
        const cases: Array<[Error, number, RegExp]> = [
            [new OwnerNotRecordedError(), 409, /no Owner recorded/],
            [new TenantIdpMissingError(), 409, /not managed by this control plane/],
            [new OwnerAccountMissingError(), 409, /no Owner account/],
            [new OwnerIdpRefusedError(new IdpAdminError(401, 'unauthorized')), 409, /refused the Owner password reset/],
            [new IdpUnreachableError(new IdpAdminTransportError('ECONNREFUSED')), 503, /could not be reached \(ECONNREFUSED\)/],
            [new OwnerResetInProgressError(), 409, /already being reset/],
        ]
        for (const [error, status, reason] of cases)
        {
            provisioning.ResetFailWith = error
            const r = await Harness.Send(host, 'POST', ResetPath)
            assert.equal(r.status, status, error.name)
            assert.match((JSON.parse(r.body) as { error: string }).error, reason)
        }
    })

    it('a ReadOnly operator is refused (403) and nothing is reset', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', ResetPath, FakeOperator.ReadOnlyToken)).status, 403)
        assert.deepEqual(provisioning.Resets, [])
    })

    it('only POST resets: GET is not a route', async () =>
    {
        const r = await Harness.Send(host, 'GET', ResetPath)
        assert.notEqual(r.status, 200)
        assert.deepEqual(provisioning.Resets, [])
    })
})
