import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'

/**
 * The cross-purpose surface of the runtime application methods (the runtime `cypher/*` endpoints on the environment
 * engine are covered by host/environment/tests/environment-cypher.test.ts).
 */
class RuntimeSurfaceFixture
{
    private static readonly PkgPrefix = 'rs-pkgs-'
    private static readonly AppsPrefix = 'rs-apps-'
    private static readonly SolPrefix = 'rs-sol-'
    private static readonly ManifestFile = 'application.json'
    private static readonly LivePointerFile = 'live'
    private static readonly NoConnectors = 'no connectors'
    private static readonly SolutionModelFile = join('models', 'model.todl')
    private static readonly SolutionModel = 'namespace acme { concept Service { } model Shop : acme { Service s1 { label = "alpha"; } } }'
    public static readonly Version = '1.0.0'
    public static readonly AppA = 'demo'
    public static readonly ServiceLabels = 'MATCH (a:Service) RETURN a.label'
    public static readonly Alpha = 'alpha'
    public static readonly NotRuntime = /operation requires a runtime tenant/
    public static readonly NameMismatch = /does not match requested name/
    public static readonly TenantId = 't1'
    public static readonly PrincipalId = 'p1'
    public static readonly TenantName = 'Tenant One'
    public static readonly Renamed = 'other-name'

    public readonly Packages = mkdtempSync(join(tmpdir(), RuntimeSurfaceFixture.PkgPrefix))
    public readonly Apps = mkdtempSync(join(tmpdir(), RuntimeSurfaceFixture.AppsPrefix))
    private readonly disposables: Array<() => Promise<void>> = []

    public static Permissive(): AccessContext
    {
        const tenant = new Tenant(RuntimeSurfaceFixture.TenantId, TenantKind.SelfHosted, RuntimeSurfaceFixture.TenantName)
        const principal = new Principal(RuntimeSurfaceFixture.PrincipalId, RuntimeSurfaceFixture.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(RuntimeSurfaceFixture.PrincipalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, RuntimeSurfaceFixture.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static async Run(body: (fx: RuntimeSurfaceFixture) => Promise<void>): Promise<void>
    {
        const fx = new RuntimeSurfaceFixture()
        try
        {
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    /** Makes version `Version` of `app` live with a manifest named `name` and no packages. */
    public LiveManifest(app: string, name: string): void
    {
        mkdirSync(join(this.Apps, app, RuntimeSurfaceFixture.Version), { recursive: true })
        writeFileSync(join(this.Apps, app, RuntimeSurfaceFixture.Version, RuntimeSurfaceFixture.ManifestFile), JSON.stringify({ name, version: RuntimeSurfaceFixture.Version, packages: [] }))
        writeFileSync(join(this.Apps, app, RuntimeSurfaceFixture.LivePointerFile), RuntimeSurfaceFixture.Version)
    }

    /** Starts a Runtime server over the fixture's directories and returns a function producing connected clients. */
    public async Runtime(): Promise<() => Promise<PragmaticClient>>
    {
        const server = new PragmaticServer({ packagesRoot: this.Packages, applicationsRoot: this.Apps, purpose: TenantPurpose.Runtime })
        await server.Start()
        this.disposables.push(async () =>
        {
            await (await server.LanguageService() as SolutionLanguageService).WhenIdle()
            await server.Dispose()
        })
        return () => this.Connect(server)
    }

    /** Starts a Development server with an opened sample solution. */
    public async Development(): Promise<PragmaticClient>
    {
        const solution = mkdtempSync(join(tmpdir(), RuntimeSurfaceFixture.SolPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, RuntimeSurfaceFixture.SolutionModelFile), RuntimeSurfaceFixture.SolutionModel)
        const server = new PragmaticServer({ packagesRoot: this.Packages })
        await server.Start()
        await server.OpenSolution(solution)
        const manager = await server.Manager()
        this.disposables.push(async () =>
        {
            await (await server.LanguageService() as SolutionLanguageService).WhenIdle()
            await manager.CloseSolution()
            await server.Dispose()
            rmSync(solution, { recursive: true, force: true })
        })
        return this.Connect(server)
    }

    public async Dispose(): Promise<void>
    {
        for (const d of this.disposables.reverse())
        {
            await d()
        }
        rmSync(this.Packages, { recursive: true, force: true })
        rmSync(this.Apps, { recursive: true, force: true })
    }

    public static Column(result: { items: unknown[][] }): unknown[]
    {
        return result.items.map(r => r[0]).sort()
    }

    /** A connection wired as the hosts wire it (the purpose's attach arguments). */
    private async Connect(server: PragmaticServer): Promise<PragmaticClient>
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const runtime = ServerConnectionHandler.RuntimeAttachArgs(server)
        const development = ServerConnectionHandler.DevelopmentAttachArgs(server)
        const handler = ServerConnectionHandler.Attach(
            serverSocket, await server.LanguageService(), await server.Manager(), RuntimeSurfaceFixture.Permissive(),
            () => Promise.reject(new Error(RuntimeSurfaceFixture.NoConnectors)), runtime.cypherQuery ?? development.cypherQuery,
            undefined, undefined, undefined, undefined, undefined, undefined, server.Purpose(), runtime.applications,
            undefined, undefined, undefined, undefined, undefined, runtime.cypherExecute ?? development.cypherExecute,
            undefined, development.devGraphService, runtime.environmentGraphHost)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        this.disposables.push(async () =>
        {
            await client.DisposeAsync()
            handler.Dispose()
        })
        return client
    }
}

test('runtime e2e: runtime tenant rejects solution/open (cross-purpose)', async () =>
{
    await RuntimeSurfaceFixture.Run(async fx =>
    {
        const client = await (await fx.Runtime())()
        await assert.rejects(() => client.OpenSolution(fx.Packages), (e: unknown) => e instanceof ResponseError && e.code === ErrorCodes.MethodNotFound)
    })
})

test('runtime e2e: development tenant rejects application/* but still queries its solution', async () =>
{
    await RuntimeSurfaceFixture.Run(async fx =>
    {
        const client = await fx.Development()
        await assert.rejects(() => client.ListApplications(), RuntimeSurfaceFixture.NotRuntime)
        await assert.rejects(() => client.OpenApplication(RuntimeSurfaceFixture.AppA), RuntimeSurfaceFixture.NotRuntime)
        const result = await client.CypherQuery(RuntimeSurfaceFixture.ServiceLabels)
        assert.deepEqual(RuntimeSurfaceFixture.Column(result), [RuntimeSurfaceFixture.Alpha])
    })
})

test('runtime e2e: open rejects a manifest whose name differs from its directory', async () =>
{
    await RuntimeSurfaceFixture.Run(async fx =>
    {
        fx.LiveManifest(RuntimeSurfaceFixture.AppA, RuntimeSurfaceFixture.Renamed)
        const client = await (await fx.Runtime())()
        await assert.rejects(() => client.OpenApplication(RuntimeSurfaceFixture.AppA), RuntimeSurfaceFixture.NameMismatch)
    })
})
