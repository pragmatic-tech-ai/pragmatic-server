import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { DelegationDepth, Grant, IdentityConfig, ResourceKind, ResourceRef, Role, type ISecurityModelConfig } from '@pragmatic-tech-ai/pragmatic-identity'
import { ErrorCodes, PragmaticClient, WsMessageSocket } from '@pragmatic-tech-ai/pragmatic-protocol'
import { MachineTls, type MachineTlsRef } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { DevGraphEngineHost } from '../../host/engine/dev-graph-engine-host.js'
import { WorkerHost } from '../worker-host.js'
import { InMemoryEnvironmentProvisioning } from '../../environments/environment-registry.js'
import type { EnvironmentProvisioning } from '../../environments/environment-provisioning.js'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'

/** One dev environment on a worker, its solution holding one widget instance in model acme.Shop. */
class DevWorkerFx
{
    public static readonly Environment = 'dev1'
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
        const solution = join(baseDir, DevWorkerFx.Environment, DevWorkerFx.SolutionDir)
        mkdirSync(join(baseDir, DevWorkerFx.Environment), { recursive: true })
        cpSync(DevWorkerFx.Fixtures(DevWorkerFx.SampleSolution), solution, { recursive: true })
        writeFileSync(join(solution, DevWorkerFx.ModelsDir, DevWorkerFx.ModelFile), DevWorkerFx.Model)
        process.env[DevWorkerFx.KeyEnv] = randomBytes(32).toString('base64')
        return baseDir
    }

    public static Provisioning(): InMemoryEnvironmentProvisioning
    {
        return new InMemoryEnvironmentProvisioning(new Map<string, EnvironmentProvisioning>([[DevWorkerFx.Environment, { displayName: DevWorkerFx.Environment, purpose: EnvironmentPurpose.Development }]]))
    }

    public static async TokenFor(worker: WorkerHost): Promise<string>
    {
        const server = await worker.RegistryForTest().ServerFor(DevWorkerFx.Environment)
        const pack = await server.Pack()
        await pack.Grants.Save(new Grant(DevWorkerFx.Environment, Role.Owner, new ResourceRef(ResourceKind.Realm, DevWorkerFx.Environment, [])))
        return (await pack.Tokens.Issue(server.Realm(), DevWorkerFx.Environment, [], null)).Token
    }

    /**
     * A structurally-valid environment setting placing the token principal. The dev graph is governed by RBAC at the
     * PolicyGate only (PR13) and never reads the security setting, so this only marks identity as configured; the dev
     * cypher read returns every row regardless.
     */
    public static ReadingModel(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: DevWorkerFx.RootUnit, name: DevWorkerFx.RootUnitName }],
            users: [{ principalId: DevWorkerFx.Environment, businessUnitId: DevWorkerFx.RootUnit }],
            teams: [],
            roleAssignments: [],
            profileAssignments: [],
            roleOverrides: [],
            profileOverrides: [],
        }
    }

    /** Stores the reading security model in the realm's identity config (kept fields: the stored ones, if any). */
    public static async SeedReader(worker: WorkerHost): Promise<void>
    {
        const server = await worker.RegistryForTest().ServerFor(DevWorkerFx.Environment)
        const store = await server.RealmConfigStore()
        const current = await store.Get(DevWorkerFx.Environment)
        const config = current === null
            ? new IdentityConfig(DevWorkerFx.PackId, DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map(), DevWorkerFx.ReadingModel())
            : new IdentityConfig(current.PackId, current.DelegationDepth, current.ProviderSettings, current.GroupRoleMap, current.ClaimsMapping, DevWorkerFx.ReadingModel())
        await store.Save(DevWorkerFx.Environment, config)
    }

    /** Waits until the environment's language service has loaded the opened solution. */
    public static async Idle(worker: WorkerHost): Promise<void>
    {
        const server = await worker.RegistryForTest().ServerFor(DevWorkerFx.Environment)
        await (await server.LanguageService() as SolutionLanguageService).WhenIdle()
    }

    public static async Connect(worker: WorkerHost, token: string): Promise<PragmaticClient>
    {
        const client = MachineTls.Client(DevWorkerFx.Tls(DevWorkerFx.ClientTls))
        const address = worker.Address()
        const headers = { [DevWorkerFx.EnvironmentHeader]: DevWorkerFx.Environment, authorization: `Bearer ${token}` }
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
            await client.OpenSolution(join(baseDir, DevWorkerFx.Environment, DevWorkerFx.SolutionDir))
            await DevWorkerFx.Idle(worker)
            const server = await worker.RegistryForTest().ServerFor(DevWorkerFx.Environment)
            const handlers = worker.HandlersForTest()
            assert.equal(handlers.length, 1)
            const host = server.DevEngine() as DevGraphEngineHost
            assert.equal(host.IsOpen, false, 'nothing has used the dev graph engine yet')
            assert.deepEqual(await client.ListGraphs(), [], 'the dev graph service is attached')
            await assert.rejects(client.CypherQuery(DevWorkerFx.UnknownLabel), (error: { code?: number }) => error.code === ErrorCodes.InvalidParams)
            const page = await client.CypherQuery(DevWorkerFx.Query)
            assert.deepEqual(page.columns, [DevWorkerFx.Column])
            assert.equal(page.items.length, 1)
            assert.match(JSON.stringify(page.items[0]), new RegExp(DevWorkerFx.Label))
            // the query was served by the environment's attached dev graph engine: the query itself opened it (the test never did)
            assert.equal(host.IsOpen, true, 'the dev cypher/query opened the attached dev graph engine')
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
