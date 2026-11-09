import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { AccessLevel, DelegationDepth, Grant, IdentityConfig, PrivilegeAction, ResourceKind, ResourceRef, Role } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { ErrorCodes, PragmaticClient, WsMessageSocket } from '@pragmatic-tech-ai/pragmatic-protocol'
import { MachineTls } from '../machine-tls.js'
import type { MachineTlsRef } from '../machine-tls.js'
import { WorkerHost } from '../worker-host.js'
import { InMemoryTenantProvisioning } from '../../tenancy/tenant-registry.js'
import type { TenantProvisioning } from '../../tenancy/tenant-provisioning.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'

/** One dev tenant on a worker, its solution holding one widget instance in model acme.Shop. */
class DevWorkerFx
{
    public static readonly Tenant = 'dev1'
    public static readonly KeyEnv = 'PS_WORKER_DEV_GRAPH_KEY'
    public static readonly Prefix = 'ps-whdg-'
    public static readonly SolutionDir = 'solution'
    public static readonly Model = 'namespace acme { concept Widget { } model Shop : acme { Widget w1 { label = "one"; } } }'
    public static readonly Query = 'MATCH (w:Widget) RETURN w.label AS label'
    public static readonly UnknownLabel = 'MATCH (x:Nope) RETURN x'
    public static readonly Widget = 'acme.Widget'
    public static readonly Label = 'one'
    public static readonly PackId = 'local'
    private static readonly RootUnit = 'root'
    private static readonly RootUnitName = 'Root'
    private static readonly ReaderRole = 'reader'
    private static readonly ReaderRoleName = 'Reader'
    public static readonly EnvironmentHeader = 'x-pragmatic-environment'
    public static readonly Column = 'label'
    public static readonly LocalHost = '127.0.0.1'
    private static readonly TlsDir = 'tls'
    private static readonly CaFile = 'ca.pem'
    private static readonly CertExtension = '.pem'
    private static readonly KeyExtension = '.key'
    public static readonly ClientTls = 'client'
    public static readonly ServerTls = 'server'
    private static readonly SampleSolution = 'sample-solution'
    private static readonly ModelsDir = 'models'
    private static readonly ModelFile = 'model.todl'

    public static Fixtures(...parts: string[]): string
    {
        return join(import.meta.dirname, '..', '..', 'tests', 'fixtures', ...parts)
    }

    public static Tls(name: string): MachineTlsRef
    {
        return { certFile: DevWorkerFx.Fixtures(DevWorkerFx.TlsDir, name + DevWorkerFx.CertExtension), keyFile: DevWorkerFx.Fixtures(DevWorkerFx.TlsDir, name + DevWorkerFx.KeyExtension), caFile: DevWorkerFx.Fixtures(DevWorkerFx.TlsDir, DevWorkerFx.CaFile) }
    }

    public static Start(): string
    {
        const baseDir = mkdtempSync(join(tmpdir(), DevWorkerFx.Prefix))
        const solution = join(baseDir, DevWorkerFx.Tenant, DevWorkerFx.SolutionDir)
        mkdirSync(join(baseDir, DevWorkerFx.Tenant), { recursive: true })
        cpSync(DevWorkerFx.Fixtures(DevWorkerFx.SampleSolution), solution, { recursive: true })
        writeFileSync(join(solution, DevWorkerFx.ModelsDir, DevWorkerFx.ModelFile), DevWorkerFx.Model)
        process.env[DevWorkerFx.KeyEnv] = randomBytes(32).toString('base64')
        return baseDir
    }

    public static Provisioning(): InMemoryTenantProvisioning
    {
        return new InMemoryTenantProvisioning(new Map<string, TenantProvisioning>([[DevWorkerFx.Tenant, { displayName: DevWorkerFx.Tenant, purpose: TenantPurpose.Development }]]))
    }

    public static async TokenFor(worker: WorkerHost): Promise<string>
    {
        const server = await worker.RegistryForTest().ServerFor(DevWorkerFx.Tenant)
        const pack = await server.Pack()
        await pack.Grants.Save(new Grant(DevWorkerFx.Tenant, Role.Owner, new ResourceRef(ResourceKind.Tenant, DevWorkerFx.Tenant, [])))
        return (await pack.Tokens.Issue(server.Tenant(), DevWorkerFx.Tenant, [], null)).Token
    }

    /** A security model granting the token principal Read on widgets at Organization level. */
    public static ReadingModel(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: DevWorkerFx.RootUnit, name: DevWorkerFx.RootUnitName }],
            teams: [],
            membership: { claimsMapping: [], overrides: [{ principalId: DevWorkerFx.Tenant, homeBusinessUnit: DevWorkerFx.RootUnit, teams: [] }] },
            ownershipRules: [],
            roles: [{ id: DevWorkerFx.ReaderRole, name: DevWorkerFx.ReaderRoleName, privileges: [{ action: PrivilegeAction.Read, concept: DevWorkerFx.Widget, level: AccessLevel.Organization }] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: DevWorkerFx.Tenant, roles: [DevWorkerFx.ReaderRole] }], teamRoles: [] },
        } as unknown as ISecurityModelConfig
    }

    /** Stores the reading security model in the tenant's identity config (kept fields: the stored ones, if any). */
    public static async SeedReader(worker: WorkerHost): Promise<void>
    {
        const server = await worker.RegistryForTest().ServerFor(DevWorkerFx.Tenant)
        const store = await server.TenantConfigStore()
        const current = await store.Get(DevWorkerFx.Tenant)
        const config = current === null
            ? new IdentityConfig(DevWorkerFx.PackId, DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map(), DevWorkerFx.ReadingModel())
            : new IdentityConfig(current.PackId, current.DelegationDepth, current.ProviderSettings, current.GroupRoleMap, current.ClaimsMapping, DevWorkerFx.ReadingModel())
        await store.Save(DevWorkerFx.Tenant, config)
    }

    /** Waits until the tenant's language service has loaded the opened solution. */
    public static async Idle(worker: WorkerHost): Promise<void>
    {
        const server = await worker.RegistryForTest().ServerFor(DevWorkerFx.Tenant)
        await (await server.LanguageService() as SolutionLanguageService).WhenIdle()
    }

    public static async Connect(worker: WorkerHost, token: string): Promise<PragmaticClient>
    {
        const client = MachineTls.Client(DevWorkerFx.Tls(DevWorkerFx.ClientTls))
        const address = worker.Address()
        const headers = { [DevWorkerFx.EnvironmentHeader]: DevWorkerFx.Tenant, authorization: `Bearer ${token}` }
        const ws = new WebSocket(`wss://${address.host}:${address.port}/`, { key: client.key, cert: client.cert, ca: client.ca, rejectUnauthorized: true, headers })
        await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject) })
        return PragmaticClient.CreateOverSocket(new WsMessageSocket(ws))
    }
}

test('worker host serves dev graph endpoints', async () =>
{
    const baseDir = DevWorkerFx.Start()
    const worker = await WorkerHost.StartAsync({ host: DevWorkerFx.LocalHost, port: 0, baseDir, masterKey: { base64Env: DevWorkerFx.KeyEnv }, provisioning: DevWorkerFx.Provisioning(), tls: DevWorkerFx.Tls(DevWorkerFx.ServerTls) })
    try
    {
        const token = await DevWorkerFx.TokenFor(worker)
        await DevWorkerFx.SeedReader(worker)
        const client = await DevWorkerFx.Connect(worker, token)
        try
        {
            await client.OpenSolution(join(baseDir, DevWorkerFx.Tenant, DevWorkerFx.SolutionDir))
            await DevWorkerFx.Idle(worker)
            const server = await worker.RegistryForTest().ServerFor(DevWorkerFx.Tenant)
            const handlers = worker.HandlersForTest()
            assert.equal(handlers.length, 1)
            assert.equal(handlers[0]!.DevEngineForTest(), server.DevEngine(), 'the dev graph engine is attached')
            assert.deepEqual(await client.ListGraphs(), [], 'the dev graph service is attached')
            await assert.rejects(client.CypherQuery(DevWorkerFx.UnknownLabel), (error: { code?: number }) => error.code === ErrorCodes.InvalidParams)
            const page = await client.CypherQuery(DevWorkerFx.Query)
            assert.deepEqual(page.columns, [DevWorkerFx.Column])
            assert.equal(page.items.length, 1)
            assert.match(JSON.stringify(page.items[0]), new RegExp(DevWorkerFx.Label))
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
        delete process.env[DevWorkerFx.KeyEnv]
    }
})
