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
import { HiveAgentInstaller } from '../hive-agent-installer.js'
import { HiveAgentUninstaller } from '../hive-agent-uninstaller.js'
import { HiveBootstrapBundle } from '../hive-bootstrap-bundle.js'
import { IngressTlsSource } from '../ingress-tls.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { KubectlError, PortForwardError } from '../kubectl.js'
import { InClusterIdpSeedSource } from '../in-cluster-idp-seed.js'
import type { TenantConsoleInstaller } from '../tenant-console-installer.js'
import { ConsoleAdvertRegistry } from '../console-advert-registry.js'
import { ConsoleDomainApprovals } from '../console-domain-approvals.js'
import { ConsoleInstallFixture, FakeInHiveIdpAdmin } from './console-install-fakes.js'

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

    it('PUT stores an ingress controller namespace and refuses one that is not a DNS label', async () =>
    {
        const ok = await Harness.Put(host, '/api/hives/h1/console', { ...Harness.Good, ingressNamespace: 'kube-system' })
        assert.equal(ok.status, 200)
        assert.equal(directory.GetHive('h1')?.console?.ingressNamespace, 'kube-system')
        const bad = await Harness.Put(host, '/api/hives/h1/console', { ...Harness.Good, ingressNamespace: 'Kube_System' })
        assert.equal(bad.status, 400)
        assert.match(JSON.parse(bad.body).error as string, /^The ingress controller namespace .*\.$/)
        assert.equal(directory.GetHive('h1')?.console?.ingressNamespace, 'kube-system')
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

class Send
{
    public static Request(host: ControlPlaneHost, method: string, path: string, body?: unknown, token: string = FakeOperator.FullToken): Promise<Reply & { headers: Record<string, string | string[] | undefined> }>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json', cookie: 'cp_session=' + token }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
            })
            req.on('error', reject)
            req.end(body === undefined ? undefined : JSON.stringify(body))
        })
    }
}

// The agent's check-ins: none until Arrive(), so a started agent install stays in its check-in wait.
class HeldCheckIns
{
    private arrived: string | undefined

    public LatestRecord(_hiveId: string): { reportedAt: string } | undefined
    {
        return this.arrived === undefined ? undefined : { reportedAt: this.arrived }
    }

    public Arrive(): void
    {
        this.arrived = new Date(Date.now() + 60000).toISOString()
    }
}

// A real advert store whose forgets can be made to fail (a store write failure after the record or setting is already gone).
class SwitchableAdverts extends ConsoleAdvertRegistry
{
    public FailForget = false

    public override async ForgetHive(hiveId: string): Promise<void>
    {
        if (this.FailForget)
        {
            throw new Error('disk full: secret-detail')
        }
        await super.ForgetHive(hiveId)
    }

    public override async ForgetTenant(tenantId: string): Promise<void>
    {
        if (this.FailForget)
        {
            throw new Error('disk full: secret-detail')
        }
        await super.ForgetTenant(tenantId)
    }
}

class SwitchableApprovals extends ConsoleDomainApprovals
{
    public FailForget = false

    public override async ForgetTenant(tenantId: string): Promise<void>
    {
        if (this.FailForget)
        {
            throw new Error('disk full: secret-detail')
        }
        await super.ForgetTenant(tenantId)
    }
}

// Captures console.error while a test body runs.
class ErrorLines
{
    public static async Capture(body: () => Promise<void>): Promise<string[]>
    {
        const lines: string[] = []
        const original = console.error
        console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
        try
        {
            await body()
        }
        finally
        {
            console.error = original
        }
        return lines
    }
}

// Keeps a console install in its first step until released.
class InstallHold
{
    private release: () => void = () => undefined

    public constructor(private readonly fx: ConsoleInstallFixture, private readonly installer: TenantConsoleInstaller)
    {
    }

    public Engage(): void
    {
        this.fx.Kubectl.Hold = new Promise<void>(resolve => { this.release = resolve })
    }

    public async Release(): Promise<void>
    {
        this.fx.Kubectl.Hold = undefined
        this.release()
        await this.installer.WhenSettled('h1')
    }
}

describe('ControlPlaneHost in-hive console install', () =>
{
    let host: ControlPlaneHost
    let parent: string
    let directory: PlatformDirectory
    let audit: AuditRegistry
    let fx: ConsoleInstallFixture
    let installer: TenantConsoleInstaller
    let agentInstaller: HiveAgentInstaller
    let checkIns: HeldCheckIns
    let hold: InstallHold
    let adverts: SwitchableAdverts
    let approvals: SwitchableApprovals

    const reportFor = (tenantId: string, hiveId: string): Promise<unknown> =>
        adverts.Report({ tenantId, hiveId, consoleUrl: 'https://console-' + tenantId + '.localtest.me', fingerprints: [], emailDomains: [], reportedAt: new Date().toISOString() })

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-console-install-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.UseDefaultTrustRoot('platform-signing')
        await directory.CreateClient({ id: 'acme', displayName: 'Acme' })
        await directory.CreateProvisionedTenant({ id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'owner@t1.test', ownerPrincipalId: 'owner', idpBaseUrl: 'https://idp.test' })
        await directory.CreateHive({ id: 'h1', tenantId: 't1', displayName: 'H1', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        await directory.SetHiveConsole('h1', { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } })
        audit = new AuditRegistry(join(parent, 'audit.json'))
        await audit.Load()
        fx = await ConsoleInstallFixture.Create()
        fx.SeedRunningIdp('t1')
        adverts = new SwitchableAdverts(join(parent, 'console-adverts.json'))
        approvals = new SwitchableApprovals(join(parent, 'console-domain-approvals.json'))
        installer = fx.InstallerOver(directory, adverts)
        hold = new InstallHold(fx, installer)
        const deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        await deployments.RegisterHive('h1')
        checkIns = new HeldCheckIns()
        agentInstaller = new HiveAgentInstaller(directory, fx.Orchestrators, deployments, checkIns, ConsoleInstallFixture.ChannelUrl, undefined, { pollIntervalMs: 20, timeoutMs: 60000 })
        host = new ControlPlaneHost({} as IEnvironmentService, {} as IGraphService, root, new FakeOperator(), false, directory, deployments,
            new FakeProvisioning(directory).AsService(), RolloutFixture.Observations(parent),
            undefined, undefined, undefined, undefined, undefined, undefined, new OperatorAuthorization(), audit, undefined, undefined,
            ConsoleInstallFixture.ChannelUrl, agentInstaller, new HiveAgentUninstaller(fx.Orchestrators), undefined, installer, adverts, approvals)
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        checkIns.Arrive()
        await agentInstaller.WhenSettled('h1')
        await host.Close()
        fx.Dispose()
        rmSync(parent, { recursive: true, force: true })
    })

    it('POST console-install answers 202 with no-store', async () =>
    {
        const r = await Send.Request(host, 'POST', '/api/hives/h1/console-install')
        assert.equal(r.status, 202)
        assert.equal(r.headers['cache-control'], 'no-store')
        assert.equal((JSON.parse(r.body) as { state: string }).state, 'installing')
        assert.equal((await installer.WhenSettled('h1'))?.state, 'deployed')
        const g = await Send.Request(host, 'GET', '/api/hives/h1/console-install')
        assert.equal(g.status, 200)
        assert.equal(g.headers['cache-control'], 'no-store')
        assert.equal((JSON.parse(g.body) as { consoleUrl: string }).consoleUrl, 'https://console-t1.localtest.me')
    })

    it('GET console-install is 404 before any run', async () =>
    {
        assert.equal((await Send.Request(host, 'GET', '/api/hives/h1/console-install')).status, 404)
        assert.equal((await Send.Request(host, 'GET', '/api/hives/nope/console-install')).status, 404)
    })

    it('POST console-install is 409 for a hive without console settings', async () =>
    {
        await directory.CreateHive({ id: 'h2', tenantId: 't1', displayName: 'H2', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        const r = await Send.Request(host, 'POST', '/api/hives/h2/console-install')
        assert.equal(r.status, 409)
        assert.match(JSON.parse(r.body).error as string, /no console settings/)
    })

    it('owner-password answers once with no-store and is not audited with the password', async () =>
    {
        const r = await Send.Request(host, 'POST', '/api/hives/h1/console/owner-password')
        assert.equal(r.status, 200)
        assert.equal(r.headers['cache-control'], 'no-store')
        assert.deepEqual(JSON.parse(r.body), { ownerEmail: 'owner@t1.test', ownerPassword: FakeInHiveIdpAdmin.Password })
        const entries = audit.Recent(10).filter(e => e.path.includes('owner-password'))
        assert.deepEqual(entries.map(e => [e.method, e.path, e.status]), [['POST', '/api/hives/h1/console/owner-password', 200]])
        assert.ok(!JSON.stringify(audit.Recent(50)).includes(FakeInHiveIdpAdmin.Password))
    })

    it('owner-password and console-install refuse a read-only operator', async () =>
    {
        assert.equal((await Send.Request(host, 'POST', '/api/hives/h1/console/owner-password', undefined, FakeOperator.ReadOnlyToken)).status, 403)
        assert.equal((await Send.Request(host, 'POST', '/api/hives/h1/console-install', undefined, FakeOperator.ReadOnlyToken)).status, 403)
        assert.equal((await Send.Request(host, 'DELETE', '/api/hives/h1/console', undefined, FakeOperator.ReadOnlyToken)).status, 403)
        assert.equal(installer.StatusFor('h1'), undefined)
    })

    it('DELETE console refuses while installing', async () =>
    {
        hold.Engage()
        assert.equal((await Send.Request(host, 'POST', '/api/hives/h1/console-install')).status, 202)
        const refused = await Send.Request(host, 'DELETE', '/api/hives/h1/console')
        assert.equal(refused.status, 409)
        assert.ok(directory.GetHive('h1')?.console !== undefined)
        await hold.Release()
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1/console')
        assert.equal(r.status, 200)
        assert.equal((JSON.parse(r.body) as { hive: HiveRecord }).hive.console, undefined)
        assert.equal(directory.GetHive('h1')?.console, undefined)
        assert.ok(fx.Kubectl.Deleted.includes(new K8sManifestBuilder().TenantConsoleRemovalManifest('t1', 'h1')))
    })

    it('DELETE console answers 409 with the redacted kubectl text and keeps the setting when the cluster refuses', async () =>
    {
        fx.Kubectl.DeleteManifestError = new KubectlError('the server is unreachable')
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1/console')
        assert.equal(r.status, 409)
        assert.match(JSON.parse(r.body).error as string, /the server is unreachable/)
        assert.ok(directory.GetHive('h1')?.console !== undefined)
    })

    it('PUT console refuses while installing', async () =>
    {
        hold.Engage()
        await Send.Request(host, 'POST', '/api/hives/h1/console-install')
        const r = await Send.Request(host, 'PUT', '/api/hives/h1/console', { baseDomain: 'example.com', tls: { source: 'development' } })
        assert.equal(r.status, 409)
        assert.equal(directory.GetHive('h1')?.console?.baseDomain, 'localtest.me')
        await hold.Release()
    })

    it('agent install refuses while the console installs', async () =>
    {
        hold.Engage()
        await Send.Request(host, 'POST', '/api/hives/h1/console-install')
        const r = await Send.Request(host, 'POST', '/api/hives/h1/agent-install')
        assert.equal(r.status, 409)
        assert.match(JSON.parse(r.body).error as string, /console install is running/)
        assert.equal(agentInstaller.StatusFor('h1'), undefined)
        assert.equal((await Send.Request(host, 'DELETE', '/api/hives/h1')).status, 409)
        await hold.Release()
    })

    it('console install refuses while the agent installs', async () =>
    {
        assert.equal((await Send.Request(host, 'POST', '/api/hives/h1/agent-install')).status, 202)
        const r = await Send.Request(host, 'POST', '/api/hives/h1/console-install')
        assert.equal(r.status, 409)
        assert.equal(installer.StatusFor('h1'), undefined)
    })

    it('hive delete removes the console before the agent and forgets its keys', async () =>
    {
        await fx.Fingerprints.Ensure('h1')
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1')
        assert.equal(r.status, 200)
        const deletes = fx.Kubectl.Calls.filter(c => c[0] === 'DeleteManifest').map(c => c[1])
        assert.equal(deletes[0], new K8sManifestBuilder().TenantConsoleRemovalManifest('t1', 'h1'))
        assert.equal(deletes[1], HiveBootstrapBundle.RemovalManifest('h1'))
        assert.equal(fx.Events[fx.Events.length - 1], 'Forget')
        assert.ok(fx.Events.indexOf('DeleteBySelector') < fx.Events.indexOf('Forget'))
        assert.deepEqual(fx.IdpAdmin.Forgotten, ['t1'])
        assert.equal(await fx.Fingerprints.Get('h1'), undefined)
        assert.equal(directory.GetHive('h1'), undefined)
    })

    it('deleting a second hive of the tenant keeps the console hive IdP credentials', async () =>
    {
        await directory.CreateHive({ id: 'h2', tenantId: 't1', displayName: 'H2', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        fx.Kubectl.Put(K8sManifestBuilder.SystemNamespace, 'deployment/' + K8sManifestBuilder.TenantAdminNameOf('t1'), { metadata: { name: K8sManifestBuilder.TenantAdminNameOf('t1'), labels: { 'pragmatic/hive': 'h1' } } })
        const r = await Send.Request(host, 'DELETE', '/api/hives/h2')
        assert.equal(r.status, 200)
        assert.equal(directory.GetHive('h2'), undefined)
        assert.deepEqual(fx.IdpAdmin.Forgotten, [])
    })

    it('DELETE console keeps the environment namespaces it created and names them, the console data and the IdP data in retained and the audit note', async () =>
    {
        fx.Kubectl.Namespaces.set('pragmatic-env-console-dev', { 'pragmatic/hive': 'h1' })
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1/console')
        assert.equal(r.status, 200)
        const body = JSON.parse(r.body) as { hive: HiveRecord; retained: string[] }
        assert.equal(body.hive.id, 'h1')
        assert.deepEqual(body.retained, [InClusterIdpSeedSource.TlsSecretNameOf('t1'), InClusterIdpSeedSource.AdminSecretNameOf('t1'), 'pragmatic-env-console-dev'])
        assert.ok(fx.Kubectl.Namespaces.has('pragmatic-env-console-dev'))
        assert.ok(!fx.Kubectl.Calls.some(c => c[0] === 'DeleteNamespacesBySelector'))
        const note = audit.Recent(10).find(e => e.method === 'DELETE' && e.path === '/api/hives/h1/console')?.note ?? ''
        assert.match(note, /^retained: .*pragmatic-env-console-dev$/)
    })

    it('DELETE console still succeeds when the kept objects cannot be listed afterwards, and says so', async () =>
    {
        fx.Kubectl.ListNamespacesError = new KubectlError('the server is unreachable')
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1/console')
        assert.equal(r.status, 200)
        const body = JSON.parse(r.body) as { hive: HiveRecord; retained: string[]; notice?: string }
        assert.deepEqual(body.retained, [])
        assert.match(body.notice ?? '', /could not be listed/)
        assert.equal(directory.GetHive('h1')?.console, undefined)
        assert.match(audit.Recent(10).find(e => e.method === 'DELETE' && e.path === '/api/hives/h1/console')?.note ?? '', /kept objects not listed/)
    })

    it('hive delete stops the in-hive IdP and reports its kept data volume and Secrets in retained', async () =>
    {
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1')
        assert.equal(r.status, 200)
        const removal = JSON.parse(new K8sManifestBuilder().TenantConsoleRemovalManifest('t1', 'h1')) as { items: Array<{ kind: string; metadata: { namespace?: string } }> }
        assert.ok(removal.items.some(i => i.kind === 'Deployment' && i.metadata.namespace === K8sManifestBuilder.IdpNameOf('t1')))
        assert.ok(fx.Kubectl.Deleted.includes(new K8sManifestBuilder().TenantConsoleRemovalManifest('t1', 'h1')))
        const body = JSON.parse(r.body) as { retained: string[] }
        assert.deepEqual(body.retained, [InClusterIdpSeedSource.TlsSecretNameOf('t1'), InClusterIdpSeedSource.AdminSecretNameOf('t1')])
    })

    it('DELETE console keeps the stored IdP credentials (the half-pair check keeps protecting kept environments); deleting the hive then forgets them', async () =>
    {
        await fx.IdpAdmin.RememberOwner('t1', 'h1')
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1/console')
        assert.equal(r.status, 200)
        assert.deepEqual(fx.IdpAdmin.Forgotten, [])
        assert.equal((await Send.Request(host, 'DELETE', '/api/hives/h1')).status, 200)
        assert.deepEqual(fx.IdpAdmin.Forgotten, ['t1'])
    })

    it('a tenant delete forgets its in-hive IdP credentials', async () =>
    {
        await directory.CreateProvisionedTenant({ id: 't2', clientId: 'acme', displayName: 'T2', ownerEmail: 'owner@t2.test', ownerPrincipalId: 'owner', idpBaseUrl: 'https://idp.test' })
        const r = await Send.Request(host, 'DELETE', '/api/tenants/t2')
        assert.equal(r.status, 200)
        assert.deepEqual(fx.IdpAdmin.Forgotten, ['t2'])
    })

    it('hive delete removes console-created environment namespaces by hive label and keeps unlabelled pragmatic-env-* namespaces', async () =>
    {
        fx.Kubectl.Namespaces.set('pragmatic-env-console-dev', { 'pragmatic/hive': 'h1' })
        fx.Kubectl.Namespaces.set('pragmatic-env-hand-made', {})
        fx.Kubectl.Namespaces.set('pragmatic-env-other-hive', { 'pragmatic/hive': 'h2' })
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1')
        assert.equal(r.status, 200)
        assert.deepEqual(fx.Kubectl.Calls.filter(c => c[0] === 'DeleteNamespacesBySelector'), [['DeleteNamespacesBySelector', 'pragmatic/hive=h1', 'pragmatic-env-']])
        assert.deepEqual([...fx.Kubectl.Namespaces.keys()].sort(), ['pragmatic-env-hand-made', 'pragmatic-env-other-hive'])
        assert.deepEqual((JSON.parse(r.body) as { failed: string[] }).failed, [])
    })

    it('hive delete names environment namespaces it could not delete in failed (not retained) and the audit note', async () =>
    {
        fx.Kubectl.Namespaces.set('pragmatic-env-stuck', { 'pragmatic/hive': 'h1' })
        fx.Kubectl.FailNamespaceDelete.add('pragmatic-env-stuck')
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1')
        assert.equal(r.status, 200)
        const body = JSON.parse(r.body) as { retained: string[]; failed: string[]; notice?: string }
        assert.deepEqual(body.failed, ['pragmatic-env-stuck'])
        assert.ok(!body.retained.includes('pragmatic-env-stuck'))
        assert.match(body.notice ?? '', /pragmatic-env-stuck/)
        assert.match(audit.Recent(10).find(e => e.method === 'DELETE')?.note ?? '', /failed: pragmatic-env-stuck/)
    })

    it('GET console-install answers reported from the advert', async () =>
    {
        await reportFor('t1', 'h1')
        const r = await Send.Request(host, 'GET', '/api/hives/h1/console-install')
        assert.equal(r.status, 200)
        const body = JSON.parse(r.body) as { state: string; consoleUrl: string; stale: boolean }
        assert.equal(body.state, 'reported')
        assert.equal(body.consoleUrl, 'https://console-t1.localtest.me')
        assert.equal(body.stale, false)
    })

    it('removing the console forgets its advert', async () =>
    {
        await reportFor('t1', 'h1')
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1/console')
        assert.equal(r.status, 200)
        assert.equal(adverts.ForTenant('t1'), undefined)
    })

    it('changing the console host keeps the advert until a reinstall reports the new host', async () =>
    {
        await reportFor('t1', 'h1')
        const r = await Harness.Put(host, '/api/hives/h1/console', { baseDomain: 'other.test', tls: { source: 'development' } })
        assert.equal(r.status, 200)
        assert.equal(adverts.ForTenant('t1')?.hiveId, 'h1')
    })

    it('hive delete forgets its advert', async () =>
    {
        await reportFor('t1', 'h1')
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1')
        assert.equal(r.status, 200)
        assert.equal(adverts.ForTenant('t1'), undefined)
    })

    it('tenant delete forgets any advert and the approved domains, and keeps approvals when only the console or hive goes', async () =>
    {
        await approvals.Approve('t1', 'acme.example')
        await reportFor('t1', 'h1')
        assert.equal((await Send.Request(host, 'DELETE', '/api/hives/h1/console')).status, 200)
        assert.deepEqual(approvals.ApprovedFor('t1'), ['acme.example'])
        assert.equal((await Send.Request(host, 'DELETE', '/api/hives/h1')).status, 200)
        assert.deepEqual(approvals.ApprovedFor('t1'), ['acme.example'])
        await directory.CreateProvisionedTenant({ id: 't2', clientId: 'acme', displayName: 'T2', ownerEmail: 'owner@t2.test', ownerPrincipalId: 'owner', idpBaseUrl: 'https://idp.test' })
        await adverts.Report({ tenantId: 't2', hiveId: 'gone', consoleUrl: 'https://console-t2.localtest.me', fingerprints: [], emailDomains: [], reportedAt: new Date().toISOString() })
        await approvals.Approve('t2', 'two.example')
        assert.equal((await Send.Request(host, 'DELETE', '/api/tenants/t2')).status, 200)
        assert.equal(adverts.ForTenant('t2'), undefined)
        assert.deepEqual(approvals.ApprovedFor('t2'), [])
    })

    it('a failing advert store does not fail a completed console removal, hive delete or tenant delete, and logs the error name only', async () =>
    {
        adverts.FailForget = true
        approvals.FailForget = true
        await directory.CreateProvisionedTenant({ id: 't2', clientId: 'acme', displayName: 'T2', ownerEmail: 'owner@t2.test', ownerPrincipalId: 'owner', idpBaseUrl: 'https://idp.test' })
        const lines = await ErrorLines.Capture(async () =>
        {
            assert.equal((await Send.Request(host, 'DELETE', '/api/hives/h1/console')).status, 200)
            assert.equal((await Send.Request(host, 'DELETE', '/api/hives/h1')).status, 200)
            assert.equal((await Send.Request(host, 'DELETE', '/api/tenants/t2')).status, 200)
        })
        assert.equal(directory.GetHive('h1'), undefined)
        assert.equal(directory.GetTenant('t2'), undefined)
        assert.equal(lines.filter(l => l.includes('advert failed: Error')).length, 3)
        assert.equal(lines.filter(l => l.includes('approved email domains failed: Error')).length, 1)
        assert.ok(lines.every(l => !l.includes('secret-detail')))
    })

    it('a forced hive delete skips the console and its namespaces but still forgets its keys', async () =>
    {
        fx.Kubectl.Namespaces.set('pragmatic-env-console-dev', { 'pragmatic/hive': 'h1' })
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1?force=true')
        assert.equal(r.status, 200)
        assert.deepEqual(fx.Kubectl.Deleted, [])
        assert.ok(fx.Kubectl.Namespaces.has('pragmatic-env-console-dev'))
        assert.match((JSON.parse(r.body) as { notice?: string }).notice ?? '', /console was not removed/)
        assert.deepEqual(fx.IdpAdmin.Forgotten, ['t1'])
    })

    it('a console removal failure aborts the hive delete fail-closed and offers delete anyway', async () =>
    {
        fx.Kubectl.DeleteManifestError = new KubectlError('connection refused')
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1')
        assert.equal(r.status, 409)
        assert.equal((JSON.parse(r.body) as { code: string }).code, 'agent-uninstall-failed')
        assert.match((JSON.parse(r.body) as { error: string }).error, /^Could not remove the hive's console \(or the environment namespaces it created\) from its cluster: /)
        assert.ok(directory.GetHive('h1') !== undefined)
        assert.deepEqual(fx.IdpAdmin.Forgotten, [])
    })

    it('owner-password answers 503 (not a masked 500) when the tunnel to the in-hive IdP cannot open', async () =>
    {
        fx.IdpAdmin.ResetError = new PortForwardError(PortForwardError.NotReadyMessage)
        const r = await Send.Request(host, 'POST', '/api/hives/h1/console/owner-password')
        assert.equal(r.status, 503)
        assert.match(JSON.parse(r.body).error as string, /port-forward/)
    })

    it('PUT console refuses an existing-secret named like the IdP own Secrets', async () =>
    {
        for (const name of [InClusterIdpSeedSource.TlsSecretNameOf('t1'), InClusterIdpSeedSource.AdminSecretNameOf('t1')])
        {
            const r = await Send.Request(host, 'PUT', '/api/hives/h1/console', { baseDomain: 'example.com', tls: { source: 'existing-secret', secretName: name } })
            assert.equal(r.status, 400)
            assert.match(JSON.parse(r.body).error as string, /^[A-Z].*identity provider.*\.$/)
        }
        assert.equal(directory.GetHive('h1')?.console?.baseDomain, 'localtest.me')
    })

    it('DELETE console during an agent install names the removal in its refusal', async () =>
    {
        assert.equal((await Send.Request(host, 'POST', '/api/hives/h1/agent-install')).status, 202)
        const r = await Send.Request(host, 'DELETE', '/api/hives/h1/console')
        assert.equal(r.status, 409)
        assert.match(JSON.parse(r.body).error as string, /before removing the console/)
    })

    it('PUT console refuses while a console removal holds the hive', async () =>
    {
        hold.Engage()
        const removal = Send.Request(host, 'DELETE', '/api/hives/h1/console')
        while (!fx.Kubectl.Calls.some(c => c[0] === 'Find'))
        {
            await new Promise(resolve => setImmediate(resolve))
        }
        const r = await Send.Request(host, 'PUT', '/api/hives/h1/console', { baseDomain: 'example.com', tls: { source: 'development' } })
        assert.equal(r.status, 409)
        await hold.Release()
        assert.equal((await removal).status, 200)
        assert.equal(directory.GetHive('h1')?.console, undefined)
    })

    it('a token reissue is refused while the console installs', async () =>
    {
        hold.Engage()
        await Send.Request(host, 'POST', '/api/hives/h1/console-install')
        const r = await Send.Request(host, 'POST', '/api/hives/h1/rollout-registration')
        assert.equal(r.status, 409)
        assert.match(JSON.parse(r.body).error as string, /console install is running/)
        await hold.Release()
    })
})
