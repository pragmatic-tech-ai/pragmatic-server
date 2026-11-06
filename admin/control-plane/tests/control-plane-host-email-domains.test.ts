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
import { HiveBackend, InfraMode } from '../platform-records.js'
import { IngressTlsSource } from '../ingress-tls.js'
import { ConsoleAdvertRegistry } from '../console-advert-registry.js'
import { ConsoleDomainApprovals } from '../console-domain-approvals.js'
import { EmailDomainSource, PlatformEmailDomains, type TenantEmailDomainsReport } from '../platform-email-domains.js'

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

class Send
{
    public static Request(host: ControlPlaneHost, method: string, path: string, body?: unknown, token: string = FakeOperator.FullToken): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json', cookie: 'cp_session=' + token }
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
            req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
        })
    }

    public static Report(r: Reply): TenantEmailDomainsReport
    {
        return JSON.parse(r.body) as TenantEmailDomainsReport
    }

    public static Error(r: Reply): string
    {
        return (JSON.parse(r.body) as { error: string }).error
    }
}

describe('ControlPlaneHost tenant email domains', () =>
{
    const BetaPath = '/api/tenants/beta/email-domains'
    const AcmePath = '/api/tenants/acme/email-domains'
    let host: ControlPlaneHost
    let parent: string
    let directory: PlatformDirectory
    let adverts: ConsoleAdvertRegistry
    let approvals: ConsoleDomainApprovals
    let audit: AuditRegistry
    let domains: PlatformEmailDomains

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-email-domains-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'c1', displayName: 'C1' })
        await directory.CreateTenant({ id: 'beta', clientId: 'c1', displayName: 'Beta' })
        await directory.CreateTenant({ id: 'acme', clientId: 'c1', displayName: 'Acme' })
        await directory.CreateHive({ id: 'acme-hive', tenantId: 'acme', displayName: 'Acme hive', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        await directory.SetHiveConsole('acme-hive', { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } })
        adverts = new ConsoleAdvertRegistry(join(parent, ConsoleAdvertRegistry.FileName))
        await adverts.Load()
        approvals = new ConsoleDomainApprovals(join(parent, ConsoleDomainApprovals.FileName))
        await approvals.Load()
        await adverts.Report({ tenantId: 'acme', hiveId: 'acme-hive', consoleUrl: 'https://console-acme.localtest.me', fingerprints: [], emailDomains: ['acme.test', 'shared.test'], reportedAt: '2026-11-04T10:00:00.000Z' })
        audit = new AuditRegistry(join(parent, 'audit.json'))
        await audit.Load()
        domains = new PlatformEmailDomains(directory, adverts, approvals)
        const deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, deployments,
            new FakeProvisioning(directory).AsService(), RolloutFixture.Observations(parent),
            undefined, undefined, undefined, undefined, undefined, undefined, new OperatorAuthorization(), audit,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, adverts, approvals, domains)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('GET reports a control-plane tenant', async () =>
    {
        await directory.SetTenantEmailDomains('beta', ['beta.test'])
        const r = await Send.Request(host, 'GET', BetaPath)
        assert.equal(r.status, 200)
        assert.deepEqual(Send.Report(r), {
            tenantId: 'beta', domains: ['beta.test'], source: EmailDomainSource.Tenant, editable: true, sharedWith: [],
            approvals: [{ domain: 'beta.test', approved: false, claimed: true, sharedWith: [] }],
        })
    })

    it('PUT stores domains, approves them (an operator set them) and answers the report', async () =>
    {
        const r = await Send.Request(host, 'PUT', BetaPath, { domains: ['Beta.test', 'shared.test'] })
        assert.equal(r.status, 200)
        assert.deepEqual(Send.Report(r), {
            tenantId: 'beta', domains: ['beta.test', 'shared.test'], source: EmailDomainSource.Tenant, editable: true, sharedWith: ['acme'],
            approvals: [{ domain: 'beta.test', approved: true, claimed: true, sharedWith: [] }, { domain: 'shared.test', approved: true, claimed: true, sharedWith: ['acme'] }],
        })
        assert.deepEqual(directory.GetTenant('beta')?.emailDomains, ['beta.test', 'shared.test'])
        assert.deepEqual(approvals.ApprovedFor('beta'), ['beta.test', 'shared.test'])
    })

    it('an operator PUT approves only the domains it adds, and notes them; the Owner\'s pending domain stays pending', async () =>
    {
        await domains.Set('beta', ['victim.test'])
        const r = await Send.Request(host, 'PUT', BetaPath, { domains: ['victim.test', 'beta.test'] })
        assert.equal(r.status, 200)
        assert.deepEqual(Send.Report(r).approvals.map(a => [a.domain, a.approved]), [['beta.test', true], ['victim.test', false]])
        assert.deepEqual(approvals.ApprovedFor('beta'), ['beta.test'])
        const again = await Send.Request(host, 'PUT', BetaPath, { domains: ['victim.test', 'beta.test'] })
        assert.equal(again.status, 200)
        const notes = audit.Recent(10).filter(e => e.method === 'PUT' && e.path === BetaPath).map(e => e.note)
        assert.deepEqual(notes.sort(), ['approved on save: beta.test', undefined].sort())
    })

    it('a domain the control-plane tenant Owner set is pending until an operator approves it', async () =>
    {
        await domains.Set('beta', ['beta.test'])
        const before = await Send.Request(host, 'GET', BetaPath)
        assert.deepEqual(Send.Report(before).approvals, [{ domain: 'beta.test', approved: false, claimed: true, sharedWith: [] }])
        const approved = await Send.Request(host, 'POST', BetaPath + '/approve', { domain: 'Beta.TEST' })
        assert.equal(approved.status, 200)
        assert.deepEqual(Send.Report(approved).approvals, [{ domain: 'beta.test', approved: true, claimed: true, sharedWith: [] }])
        assert.deepEqual(approvals.ApprovedFor('beta'), ['beta.test'])
    })

    it('revoke refuses a malformed or over-long domain with 400 and audits no note', async () =>
    {
        for (const domain of ['not a domain', 'x'.repeat(15000)])
        {
            const r = await Send.Request(host, 'POST', AcmePath + '/revoke', { domain })
            assert.equal(r.status, 400)
        }
        const entries = audit.Recent(10).filter(e => e.path.endsWith('/revoke'))
        assert.equal(entries.length, 2)
        assert.ok(entries.every(e => e.status === 400 && e.note === undefined))
    })

    it('PUT takes a list of 20 long domains (16 KiB cap)', async () =>
    {
        const domains = Array.from({ length: 20 }, (_, i) => ['a', 'b', 'c', 'e'].map(c => c.repeat(60)).join('.') + '.d' + String(i) + '.test')
        assert.ok(Buffer.byteLength(JSON.stringify({ domains })) > 4096)
        const r = await Send.Request(host, 'PUT', BetaPath, { domains })
        assert.equal(r.status, 200)
        assert.equal(Send.Report(r).domains.length, 20)
        const tooLarge = await Send.Request(host, 'PUT', BetaPath, { domains: ['x'.repeat(17000)] })
        assert.equal(tooLarge.status, 413)
    })

    it('PUT on an in-hive tenant is 409', async () =>
    {
        const r = await Send.Request(host, 'PUT', AcmePath, { domains: ['acme.test'] })
        assert.equal(r.status, 409)
        assert.equal(Send.Error(r), "This tenant's console runs in its hive; its email domains are set there by the tenant Owner.")
    })

    it('PUT with gmail.com is 400 naming it', async () =>
    {
        const r = await Send.Request(host, 'PUT', BetaPath, { domains: ['gmail.com'] })
        assert.equal(r.status, 400)
        assert.match(Send.Error(r), /^gmail\.com is a public mail domain/)
        assert.equal(directory.GetTenant('beta')?.emailDomains, undefined)
    })

    it('PUT without domains is 400', async () =>
    {
        const r = await Send.Request(host, 'PUT', BetaPath, {})
        assert.equal(r.status, 400)
        assert.equal(Send.Error(r), 'domains (array of domain names) is required')
    })

    it('an unknown tenant is 404', async () =>
    {
        assert.equal((await Send.Request(host, 'GET', '/api/tenants/nope/email-domains')).status, 404)
        assert.equal((await Send.Request(host, 'PUT', '/api/tenants/nope/email-domains', { domains: [] })).status, 404)
        assert.equal((await Send.Request(host, 'POST', '/api/tenants/nope/email-domains/approve', { domain: 'acme.test' })).status, 404)
    })

    it('a read-only operator gets 403', async () =>
    {
        const ro = FakeOperator.ReadOnlyToken
        assert.equal((await Send.Request(host, 'GET', BetaPath, undefined, ro)).status, 200)
        assert.equal((await Send.Request(host, 'PUT', BetaPath, { domains: ['beta.test'] }, ro)).status, 403)
        assert.equal((await Send.Request(host, 'POST', AcmePath + '/approve', { domain: 'acme.test' }, ro)).status, 403)
        assert.equal((await Send.Request(host, 'POST', AcmePath + '/revoke', { domain: 'acme.test' }, ro)).status, 403)
        assert.equal(directory.GetTenant('beta')?.emailDomains, undefined)
        assert.deepEqual(approvals.ApprovedFor('acme'), [])
    })

    it('GET on an in-hive tenant lists each advertised domain with its approval and other claimants', async () =>
    {
        await directory.SetTenantEmailDomains('beta', ['shared.test'])
        await approvals.Approve('acme', 'acme.test')
        const r = await Send.Request(host, 'GET', AcmePath)
        assert.equal(r.status, 200)
        assert.deepEqual(Send.Report(r), {
            tenantId: 'acme', domains: ['acme.test', 'shared.test'], source: EmailDomainSource.Console, editable: false, reportedAt: '2026-11-04T10:00:00.000Z',
            sharedWith: ['beta'],
            approvals: [{ domain: 'acme.test', approved: true, claimed: true, sharedWith: [] }, { domain: 'shared.test', approved: false, claimed: true, sharedWith: ['beta'] }],
        })
    })

    it('approve and revoke change one domain and answer the report', async () =>
    {
        const approved = await Send.Request(host, 'POST', AcmePath + '/approve', { domain: 'Shared.TEST' })
        assert.equal(approved.status, 200)
        assert.deepEqual(Send.Report(approved).approvals?.map(a => [a.domain, a.approved]), [['acme.test', false], ['shared.test', true]])
        assert.deepEqual(approvals.ApprovedFor('acme'), ['shared.test'])
        const revoked = await Send.Request(host, 'POST', AcmePath + '/revoke', { domain: 'shared.test' })
        assert.equal(revoked.status, 200)
        assert.deepEqual(Send.Report(revoked).approvals?.map(a => a.approved), [false, false])
        assert.deepEqual(approvals.ApprovedFor('acme'), [])
        const again = await Send.Request(host, 'POST', AcmePath + '/revoke', { domain: 'shared.test' })
        assert.equal(again.status, 200)
        assert.deepEqual(Send.Report(again).approvals?.map(a => a.approved), [false, false])
        assert.deepEqual(approvals.ApprovedFor('acme'), [])
    })

    it('revoking a never-approved domain is 200, stores a revoke and leaves approvals unchanged', async () =>
    {
        await approvals.Approve('acme', 'acme.test')
        const r = await Send.Request(host, 'POST', AcmePath + '/revoke', { domain: 'shared.test' })
        assert.equal(r.status, 200)
        assert.deepEqual(approvals.ApprovedFor('acme'), ['acme.test'])
        assert.deepEqual(approvals.RevokedFor('acme'), ['shared.test'])
    })

    it('revoke clears a stored approval the policy now refuses', async () =>
    {
        await approvals.Put({ id: 'acme', tenantId: 'acme', domains: ['acme.test', 'gmail.com'] })
        const r = await Send.Request(host, 'POST', AcmePath + '/revoke', { domain: 'gmail.com' })
        assert.equal(r.status, 200)
        assert.deepEqual(approvals.ApprovedFor('acme'), ['acme.test'])
    })

    it('approving a domain the console does not advertise is 409 with a sentence', async () =>
    {
        const r = await Send.Request(host, 'POST', AcmePath + '/approve', { domain: 'other.test' })
        assert.equal(r.status, 409)
        assert.equal(Send.Error(r), "other.test is not among the email domains this tenant's console reports, so there is nothing to approve.")
        assert.deepEqual(approvals.ApprovedFor('acme'), [])
    })

    it('approving a domain a control-plane record does not hold is 409, and a bad approval body is 400', async () =>
    {
        await domains.Set('beta', ['beta.test'])
        const cp = await Send.Request(host, 'POST', BetaPath + '/approve', { domain: 'other.test' })
        assert.equal(cp.status, 409)
        assert.equal(Send.Error(cp), "other.test is not among this tenant's email domains, so there is nothing to approve.")
        for (const body of [{}, { domain: 7 }, { domain: '' }])
        {
            const r = await Send.Request(host, 'POST', AcmePath + '/approve', body)
            assert.equal(r.status, 400)
            assert.equal(Send.Error(r), 'domain (an email domain name) is required')
        }
        assert.equal((await Send.Request(host, 'POST', AcmePath + '/approve', { domain: 'gmail.com' })).status, 400)
        assert.equal((await Send.Request(host, 'GET', AcmePath + '/approve')).status, 404)
    })

    it('approvals, revokes and edits are audited with the operator, the status and the domain', async () =>
    {
        await Send.Request(host, 'POST', AcmePath + '/approve', { domain: 'acme.test' })
        await Send.Request(host, 'POST', AcmePath + '/approve', { domain: 'other.test' })
        await Send.Request(host, 'POST', AcmePath + '/revoke', { domain: 'acme.test' })
        await Send.Request(host, 'PUT', BetaPath, { domains: ['beta.test'] })
        const entries = audit.Recent(10).filter(e => e.path.includes('/email-domains'))
        assert.deepEqual(entries.map(e => [e.actor, e.method, e.path, e.status, e.note]).sort(), [
            ['op@example.com', 'POST', AcmePath + '/approve', 200, 'domain: acme.test'],
            ['op@example.com', 'POST', AcmePath + '/approve', 409, undefined],
            ['op@example.com', 'POST', AcmePath + '/revoke', 200, 'domain: acme.test'],
            ['op@example.com', 'PUT', BetaPath, 200, 'approved on save: beta.test'],
        ].sort())
    })
})

describe('ControlPlaneHost without an email-domain service', () =>
{
    it('the email-domain paths are not routes', async () =>
    {
        const parent = mkdtempSync(join(tmpdir(), 'cp-email-domains-off-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.CreateClient({ id: 'c1', displayName: 'C1' })
        await directory.CreateTenant({ id: 'beta', clientId: 'c1', displayName: 'Beta' })
        const deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        const host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, deployments,
            new FakeProvisioning(directory).AsService(), RolloutFixture.Observations(parent))
        await host.Listen(0, '127.0.0.1')
        try
        {
            assert.equal((await Send.Request(host, 'PUT', '/api/tenants/beta/email-domains', { domains: ['beta.test'] })).status, 404)
            assert.equal(directory.GetTenant('beta')?.emailDomains, undefined)
        }
        finally
        {
            await host.Close()
            rmSync(parent, { recursive: true, force: true })
        }
    })
})
