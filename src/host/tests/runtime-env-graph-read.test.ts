import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import {
    Repository, Cardinality, toJSON, BlobPackageStore, StoragePackageSink, StoragePackageSource,
    type PackageDocument, type CompiledPackage,
} from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import type { GraphLoadParamsDto, GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PragmaticServer } from '../../pragmatic-server.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { RuntimeAppGraph } from '../cypher/runtime-app-graph.js'
import { NoEnvironmentGraphError, type IEnvironmentGraphHost } from '../graphs/environment-graph.js'

class FakeEnvironmentGraphHost implements IEnvironmentGraphHost
{
    public Consulted = 0
    private readonly query: IGraphQuery | undefined

    public constructor(query: IGraphQuery | undefined)
    {
        this.query = query
    }

    public LoadEnvironmentGraph(_params: GraphLoadParamsDto): Promise<GraphLoadedDto>
    {
        return Promise.reject(new Error(EnvReadFixture.NotUsed))
    }

    public LoadedGraph(): Promise<GraphLoadedDto | null>
    {
        return Promise.resolve(null)
    }

    public EnvironmentGraphQuery(): Promise<IGraphQuery>
    {
        this.Consulted++
        if (this.query === undefined)
        {
            return Promise.reject(new NoEnvironmentGraphError())
        }
        return Promise.resolve(this.query)
    }
}

class EnvReadFixture
{
    public static readonly NotUsed = 'not used'
    public static readonly NoConnectors = 'no connectors'
    public static readonly TenantId = 't1'
    public static readonly PrincipalId = 'p1'
    public static readonly TenantName = 'Tenant One'
    public static readonly Version = '1.0.0'
    public static readonly Namespace = 'shop'
    public static readonly Label = 'label'
    public static readonly Widget = 'Widget'
    public static readonly Element = 'Element'
    public static readonly StringType = 'string'
    public static readonly ManifestFile = 'application.json'
    public static readonly SourceSuffix = '.todl'
    public static readonly EnvPkg = 'envpkg'
    public static readonly AppPkg = 'apppkg'
    public static readonly AppName = 'demo'
    public static readonly EnvLabel = 'FromEnv'
    public static readonly AppLabel = 'FromApp'
    public static readonly WidgetLabels = 'MATCH (w:Widget) RETURN w.label AS label'
    public static readonly NoGraphMessage = /no environment graph is loaded/
    public static readonly Prefix = 'envread-'

    public readonly Dir = mkdtempSync(join(tmpdir(), EnvReadFixture.Prefix))
    public readonly Apps = mkdtempSync(join(tmpdir(), EnvReadFixture.Prefix))
    private readonly disposables: Array<() => Promise<void>> = []

    public static async Run(body: (fx: EnvReadFixture) => Promise<void>): Promise<void>
    {
        const fx = new EnvReadFixture()
        try
        {
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    public async PublishPackage(pkgId: string, label: string): Promise<void>
    {
        const repo = new Repository()
        const id = `${EnvReadFixture.Namespace}.${pkgId}`
        repo.builder()
            .defineConcept(EnvReadFixture.Element)
            .defineConcept(EnvReadFixture.Widget, EnvReadFixture.Element)
            .addField(EnvReadFixture.Widget, EnvReadFixture.Label, EnvReadFixture.StringType, Cardinality.Optional)
            .setNamespace(EnvReadFixture.Namespace)
            .assertInstance(EnvReadFixture.Widget, id)
            .setField(id, EnvReadFixture.Label, label)
            .commit()
        const doc = toJSON(repo) as PackageDocument
        const pkg: CompiledPackage = {
            id: pkgId, version: EnvReadFixture.Version, document: doc, fullDocument: doc,
            sources: [{ uri: pkgId + EnvReadFixture.SourceSuffix, text: '' }], classes: [],
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.Dir))).persist(pkg)
    }

    public WriteApp(): void
    {
        mkdirSync(join(this.Apps, EnvReadFixture.AppName))
        writeFileSync(join(this.Apps, EnvReadFixture.AppName, EnvReadFixture.ManifestFile), JSON.stringify({
            name: EnvReadFixture.AppName, version: EnvReadFixture.Version, packages: [{ id: EnvReadFixture.AppPkg, version: EnvReadFixture.Version }],
        }))
    }

    public async EnvQuery(): Promise<IGraphQuery>
    {
        const source = new StoragePackageSource(new NodeFsStorage(this.Dir))
        return RuntimeAppGraph.BuildQueryFromPackages(source, [{ id: EnvReadFixture.EnvPkg, version: EnvReadFixture.Version }])
    }

    public async Connect(host: IEnvironmentGraphHost): Promise<PragmaticClient>
    {
        const server = new PragmaticServer({ packagesRoot: this.Dir, applicationsRoot: this.Apps, purpose: TenantPurpose.Runtime })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        this.disposables.push(async () =>
        {
            await (languageService as SolutionLanguageService).WhenIdle()
            await server.Dispose()
        })
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(
            serverSocket, languageService, manager, EnvReadFixture.Permissive(),
            () => Promise.reject(new Error(EnvReadFixture.NoConnectors)), ctx => server.Graph(ctx),
            undefined, undefined, undefined, undefined, undefined, undefined, TenantPurpose.Runtime,
            server.Applications(),
            (ctx, name, labels) => server.GraphForPragmaticApp(ctx, name, labels),
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            host)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        this.disposables.push(async () =>
        {
            await client.DisposeAsync()
            handler.Dispose()
        })
        return client
    }

    public async Dispose(): Promise<void>
    {
        for (const d of this.disposables.reverse())
        {
            await d()
        }
        rmSync(this.Dir, { recursive: true, force: true })
        rmSync(this.Apps, { recursive: true, force: true })
    }

    public static Column(result: { items: unknown[][] }): unknown[]
    {
        return result.items.map(r => r[0]).sort()
    }

    private static Permissive(): AccessContext
    {
        const tenant = new Tenant(EnvReadFixture.TenantId, TenantKind.SelfHosted, EnvReadFixture.TenantName)
        const principal = new Principal(EnvReadFixture.PrincipalId, EnvReadFixture.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(EnvReadFixture.PrincipalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, EnvReadFixture.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }
}

test('runtime with no bound app reads the environment graph over cypher', async () =>
{
    await EnvReadFixture.Run(async fx =>
    {
        await fx.PublishPackage(EnvReadFixture.EnvPkg, EnvReadFixture.EnvLabel)
        const host = new FakeEnvironmentGraphHost(await fx.EnvQuery())
        const client = await fx.Connect(host)
        const result = await client.CypherQuery(EnvReadFixture.WidgetLabels)
        assert.deepEqual(EnvReadFixture.Column(result), [EnvReadFixture.EnvLabel])
        assert.equal(host.Consulted, 1)
    })
})

test('env_graph_query_without_load_errors_clearly', async () =>
{
    await EnvReadFixture.Run(async fx =>
    {
        const client = await fx.Connect(new FakeEnvironmentGraphHost(undefined))
        await assert.rejects(() => client.CypherQuery(EnvReadFixture.WidgetLabels), EnvReadFixture.NoGraphMessage)
    })
})

test('runtime with a bound app still queries the app graph and never consults the environment graph', async () =>
{
    await EnvReadFixture.Run(async fx =>
    {
        await fx.PublishPackage(EnvReadFixture.EnvPkg, EnvReadFixture.EnvLabel)
        await fx.PublishPackage(EnvReadFixture.AppPkg, EnvReadFixture.AppLabel)
        fx.WriteApp()
        const host = new FakeEnvironmentGraphHost(await fx.EnvQuery())
        const client = await fx.Connect(host)
        await client.OpenApplication(EnvReadFixture.AppName)
        const result = await client.CypherQuery(EnvReadFixture.WidgetLabels)
        assert.deepEqual(EnvReadFixture.Column(result), [EnvReadFixture.AppLabel])
        assert.equal(host.Consulted, 0)
    })
})
