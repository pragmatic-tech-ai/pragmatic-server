import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:https'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { BlobPackageStore, compilePackage, StoragePackageSink } from '@pragmatic-tech-ai/todl'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { AccessLevel, DelegationDepth, Grant, IdentityConfig, PrivilegeAction, ResourceKind, ResourceRef, Role } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticClient, WsMessageSocket } from '@pragmatic-tech-ai/pragmatic-protocol'
import { WorkerHost } from '../worker-host.js'
import { MachineTls } from '../machine-tls.js'
import type { MachineTlsRef } from '../machine-tls.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'

interface Reply
{
    status: number
    type: string
    body: string
}

class WorkerServeFixture
{
    public static readonly KeyEnv = 'PS_WHAS_KEY'
    private static readonly Dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'tls')

    public static Server(): MachineTlsRef
    {
        return { certFile: join(WorkerServeFixture.Dir, 'server.pem'), keyFile: join(WorkerServeFixture.Dir, 'server.key'), caFile: join(WorkerServeFixture.Dir, 'ca.pem') }
    }

    public static Client(): MachineTlsRef
    {
        return { certFile: join(WorkerServeFixture.Dir, 'client.pem'), keyFile: join(WorkerServeFixture.Dir, 'client.key'), caFile: join(WorkerServeFixture.Dir, 'ca.pem') }
    }

    public static Get(port: number, path: string): Promise<Reply>
    {
        const client = MachineTls.Client(WorkerServeFixture.Client())
        return new Promise<Reply>((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port, path, method: 'GET', key: client.key, cert: client.cert, ca: client.ca }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end()
        })
    }
}

test('a worker dispatches /app/<tenant>/<app>/ to AppServingEndpoint exactly like the main host', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-whas-'))
    process.env[WorkerServeFixture.KeyEnv] = randomBytes(32).toString('base64')
    const apps = join(baseDir, 't1', 'applications')
    mkdirSync(join(apps, 'shop', 'ui', 'assets'), { recursive: true })
    writeFileSync(join(apps, 'shop', 'ui', 'index.html'), '<html><head></head><body>shell</body></html>')
    writeFileSync(join(apps, 'shop', 'ui', 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(apps, 'secret.txt'), 'TOP-SECRET')
    writeFileSync(join(apps, 'shop', 'application.json'), JSON.stringify({ name: 'shop', version: '1.0.0', packages: [], ui: { entry: 'index.html', assets: ['assets/app.js'] } }))
    const provisioning = new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([['t1', { displayName: 'T1', purpose: TenantPurpose.Runtime }]]))
    const worker = await WorkerHost.StartAsync({ port: 0, baseDir, masterKey: { base64Env: WorkerServeFixture.KeyEnv }, provisioning, tls: WorkerServeFixture.Server() })
    try
    {
        const port = worker.Address().port
        const shell = await WorkerServeFixture.Get(port, '/app/t1/shop/')
        assert.equal(shell.status, 200)
        assert.match(shell.type, /^text\/html/)
        assert.ok(shell.body.includes('<meta name="pragmatic-app" content="shop">'))
        const asset = await WorkerServeFixture.Get(port, '/app/t1/shop/assets/app.js')
        assert.equal(asset.status, 200)
        assert.match(asset.type, /^text\/javascript/)
        assert.equal((await WorkerServeFixture.Get(port, '/app/t1/nope/')).status, 404)
        const traversal = await WorkerServeFixture.Get(port, '/app/t1/shop/..%2f..%2fsecret.txt')
        assert.notEqual(traversal.status, 200)
        assert.ok(!traversal.body.includes('TOP-SECRET'))
    }
    finally
    {
        await worker.DisposeAsync()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[WorkerServeFixture.KeyEnv]
    }
})

/** A runtime tenant on a worker delivering package `crm` (one seeded account) through the live app `crm-app`. */
class RuntimeWorkerFx
{
    public static readonly Tenant = 'rt1'
    public static readonly KeyEnv = 'PS_WHAS_RUNTIME_KEY'
    public static readonly Prefix = 'ps-whrt-'
    public static readonly LocalHost = '127.0.0.1'
    public static readonly App = 'crm-app'
    public static readonly AppVersion = '1.0.0'
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly CrmTodl = 'namespace crm {\n  concept Account { name : string?; }\n  model Crm : crm { Account a1 { name = "one"; } }\n}\n'
    public static readonly Account = 'crm.Account'
    public static readonly Query = 'MATCH (a:`crm.Account`) RETURN a.name AS name'
    public static readonly Column = 'name'
    public static readonly Seeded = 'one'
    public static readonly EnvironmentHeader = 'x-pragmatic-environment'
    public static readonly PackId = 'local'
    private static readonly SourceSuffix = '.todl'
    private static readonly ManifestFile = 'application.json'
    private static readonly LivePointerFile = 'live'
    private static readonly PackagesDir = 'packages'
    private static readonly ApplicationsDir = 'applications'
    private static readonly RootUnit = 'root'
    private static readonly RootUnitName = 'Root'
    private static readonly ReaderRole = 'reader'
    private static readonly ReaderRoleName = 'Reader'

    /** The tenant directory with `crm` compiled into `packages/` and `crm-app` live on it. */
    public static async Start(): Promise<string>
    {
        const baseDir = mkdtempSync(join(tmpdir(), RuntimeWorkerFx.Prefix))
        const tenantDir = join(baseDir, RuntimeWorkerFx.Tenant)
        const packages = join(tenantDir, RuntimeWorkerFx.PackagesDir)
        const appDir = join(tenantDir, RuntimeWorkerFx.ApplicationsDir, RuntimeWorkerFx.App)
        mkdirSync(packages, { recursive: true })
        mkdirSync(join(appDir, RuntimeWorkerFx.AppVersion), { recursive: true })
        const outcome = compilePackage([], [{ uri: RuntimeWorkerFx.Crm.id + RuntimeWorkerFx.SourceSuffix, text: RuntimeWorkerFx.CrmTodl }], RuntimeWorkerFx.Crm, [])
        assert.ok(outcome.ok, JSON.stringify(outcome.errors))
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(packages))).persist(outcome.package!)
        const manifest = { name: RuntimeWorkerFx.App, version: RuntimeWorkerFx.AppVersion, packages: [RuntimeWorkerFx.Crm] }
        writeFileSync(join(appDir, RuntimeWorkerFx.AppVersion, RuntimeWorkerFx.ManifestFile), JSON.stringify(manifest))
        writeFileSync(join(appDir, RuntimeWorkerFx.LivePointerFile), RuntimeWorkerFx.AppVersion)
        process.env[RuntimeWorkerFx.KeyEnv] = randomBytes(32).toString('base64')
        return baseDir
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([[RuntimeWorkerFx.Tenant, { displayName: RuntimeWorkerFx.Tenant, purpose: TenantPurpose.Runtime }]]))
    }

    /** An Owner token for the tenant principal, and a security model letting it read every account. */
    public static async TokenFor(worker: WorkerHost): Promise<string>
    {
        const server = await worker.RegistryForTest().ServerFor(RuntimeWorkerFx.Tenant)
        const pack = await server.Pack()
        await pack.Grants.Save(new Grant(RuntimeWorkerFx.Tenant, Role.Owner, new ResourceRef(ResourceKind.Tenant, RuntimeWorkerFx.Tenant, [])))
        const store = await server.TenantConfigStore()
        const current = await store.Get(RuntimeWorkerFx.Tenant)
        const config = current === null
            ? new IdentityConfig(RuntimeWorkerFx.PackId, DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map(), RuntimeWorkerFx.ReadingModel())
            : new IdentityConfig(current.PackId, current.DelegationDepth, current.ProviderSettings, current.GroupRoleMap, current.ClaimsMapping, RuntimeWorkerFx.ReadingModel())
        await store.Save(RuntimeWorkerFx.Tenant, config)
        return (await pack.Tokens.Issue(server.Tenant(), RuntimeWorkerFx.Tenant, [], null)).Token
    }

    public static ReadingModel(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: RuntimeWorkerFx.RootUnit, name: RuntimeWorkerFx.RootUnitName }],
            teams: [],
            membership: { claimsMapping: [], overrides: [{ principalId: RuntimeWorkerFx.Tenant, homeBusinessUnit: RuntimeWorkerFx.RootUnit, teams: [] }] },
            ownershipRules: [],
            roles: [{ id: RuntimeWorkerFx.ReaderRole, name: RuntimeWorkerFx.ReaderRoleName, privileges: [{ action: PrivilegeAction.Read, concept: RuntimeWorkerFx.Account, level: AccessLevel.Organization }] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: RuntimeWorkerFx.Tenant, roles: [RuntimeWorkerFx.ReaderRole] }], teamRoles: [] },
        } as unknown as ISecurityModelConfig
    }

    public static async Connect(worker: WorkerHost, token: string): Promise<PragmaticClient>
    {
        const client = MachineTls.Client(WorkerServeFixture.Client())
        const address = worker.Address()
        const headers = { [RuntimeWorkerFx.EnvironmentHeader]: RuntimeWorkerFx.Tenant, authorization: `Bearer ${token}` }
        const ws = new WebSocket(`wss://${address.host}:${address.port}/`, { key: client.key, cert: client.cert, ca: client.ca, rejectUnauthorized: true, headers })
        await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject) })
        return PragmaticClient.CreateOverSocket(new WsMessageSocket(ws))
    }
}

test('worker host serves runtime cypher', async () =>
{
    const baseDir = await RuntimeWorkerFx.Start()
    const worker = await WorkerHost.StartAsync({ host: RuntimeWorkerFx.LocalHost, port: 0, baseDir, masterKey: { base64Env: RuntimeWorkerFx.KeyEnv }, provisioning: RuntimeWorkerFx.Provisioning(), tls: WorkerServeFixture.Server() })
    try
    {
        const client = await RuntimeWorkerFx.Connect(worker, await RuntimeWorkerFx.TokenFor(worker))
        try
        {
            assert.deepEqual((await client.CypherModels()).models, [RuntimeWorkerFx.Crm.id], 'cypher/models is the environment\'s')
            const page = await client.CypherQuery(RuntimeWorkerFx.Query)
            assert.deepEqual(page.columns, [RuntimeWorkerFx.Column])
            assert.deepEqual(page.items, [[RuntimeWorkerFx.Seeded]], 'served by the environment engine, no application/open needed')
        }
        finally
        {
            await client.DisposeAsync()
        }
    }
    finally
    {
        await worker.DisposeAsync()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[RuntimeWorkerFx.KeyEnv]
    }
})
