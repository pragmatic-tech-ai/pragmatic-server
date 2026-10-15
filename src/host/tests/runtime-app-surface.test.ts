import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import {
    Repository, Cardinality, toJSON, BlobPackageStore, StoragePackageSink,
    PolicyNodeKind, PolicyRefRoot, PolicyCompareOp,
    type PackageDocument, type CompiledPackage,
} from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AccessPolicySetting } from '../apps/access-policy-setting.js'

class RuntimeSurfaceFixture
{
    private static readonly PkgPrefix = 'rs-pkgs-'
    private static readonly AppsPrefix = 'rs-apps-'
    private static readonly SolPrefix = 'rs-sol-'
    private static readonly ManifestFile = 'application.json'
    private static readonly SourceSuffix = '.todl'
    private static readonly NoConnectors = 'no connectors'
    private static readonly Namespace = 'shop'
    private static readonly Deny = 'deny'
    private static readonly Read = 'read'
    private static readonly Label = 'label'
    private static readonly Next = 'next'
    private static readonly Prev = 'prev'
    private static readonly Element = 'Element'
    private static readonly StringType = 'string'
    private static readonly SolutionModelFile = join('models', 'model.todl')
    private static readonly SolutionModel = 'namespace acme { concept Service { label : string?; } model Shop : acme { Service s1 { label = "alpha"; } } }'
    public static readonly Version = '1.0.0'
    public static readonly Widget = 'Widget'
    public static readonly Gadget = 'Gadget'
    public static readonly AppA = 'demo'
    public static readonly AppB = 'demo2'
    public static readonly PkgA = 'shop'
    public static readonly PkgB = 'depot'
    public static readonly OpenPolicy = '{}'
    public static readonly MalformedPolicy = '{ not json'
    public static readonly WidgetLabels = 'MATCH (w:Widget) RETURN w.label AS label'
    public static readonly GadgetLabels = 'MATCH (g:Gadget) RETURN g.label AS label'
    public static readonly EdgeQuery = 'MATCH (a:Widget)-[:next]->(b:Widget) RETURN a.label AS a, b.label AS b'
    public static readonly ServiceLabels = 'MATCH (a:Service) RETURN a.label'
    public static readonly Hi = 'Hi'
    public static readonly Bye = 'Bye'
    public static readonly Cog = 'Cog'
    public static readonly Nut = 'Nut'
    public static readonly Bolt = 'Bolt'
    public static readonly Alpha = 'alpha'
    public static readonly NoAppSelected = /no application selected/i
    public static readonly NotRuntime = /operation requires a runtime tenant/
    public static readonly NameMismatch = /does not match requested name/
    public static readonly TenantId = 't1'
    public static readonly PrincipalId = 'p1'
    public static readonly TenantName = 'Tenant One'
    public static readonly Renamed = 'other-name'
    public static readonly NotDevelopment = /operation requires a development tenant/
    public static readonly MalformedPolicyMessage = /Access policy is not valid JSON/
    public static readonly UnknownLabel = /unknown label/i

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

    /** Publishes a package and writes an application bound to it. */
    public async Seed(app: string, pkgId: string, concept: string, labels: string[], linkFirstToSecond: boolean): Promise<void>
    {
        const repo = new Repository()
        const builder = repo.builder()
            .defineConcept(RuntimeSurfaceFixture.Element)
            .defineConcept(concept, RuntimeSurfaceFixture.Element)
            .addField(concept, RuntimeSurfaceFixture.Label, RuntimeSurfaceFixture.StringType, Cardinality.Optional)
            .addConceptRelationship(concept, RuntimeSurfaceFixture.Next, [concept], Cardinality.Optional, RuntimeSurfaceFixture.Prev)
            .setNamespace(RuntimeSurfaceFixture.Namespace)
        const ids = labels.map((_, i) => `${RuntimeSurfaceFixture.Namespace}.${pkgId}${i}`)
        labels.forEach((label, i) => builder.assertInstance(concept, ids[i]!).setField(ids[i]!, RuntimeSurfaceFixture.Label, label))
        if (linkFirstToSecond)
        {
            builder.addRelationship(ids[0]!, RuntimeSurfaceFixture.Next, ids[1]!)
        }
        builder.commit()
        const doc = toJSON(repo) as PackageDocument
        const pkg: CompiledPackage = {
            id: pkgId, version: RuntimeSurfaceFixture.Version, document: doc, fullDocument: doc,
            sources: [{ uri: pkgId + RuntimeSurfaceFixture.SourceSuffix, text: '' }], classes: [],
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.Packages))).persist(pkg)
        mkdirSync(join(this.Apps, app))
        writeFileSync(join(this.Apps, app, RuntimeSurfaceFixture.ManifestFile), JSON.stringify({
            name: app, version: RuntimeSurfaceFixture.Version, packages: [{ id: pkgId, version: RuntimeSurfaceFixture.Version }],
        }))
    }

    public RenameManifest(app: string, name: string): void
    {
        writeFileSync(join(this.Apps, app, RuntimeSurfaceFixture.ManifestFile), JSON.stringify({ name, version: RuntimeSurfaceFixture.Version, packages: [] }))
    }

    public WritePolicy(app: string, text: string): void
    {
        writeFileSync(join(this.Apps, app, AccessPolicySetting.PolicyFile), text)
    }

    public DenyLabel(app: string, concept: string, label: string): void
    {
        const rules = [{
            effect: RuntimeSurfaceFixture.Deny, action: RuntimeSurfaceFixture.Read,
            predicate: {
                kind: PolicyNodeKind.Compare, op: PolicyCompareOp.Eq,
                left: { kind: PolicyNodeKind.Ref, root: PolicyRefRoot.Entity, member: RuntimeSurfaceFixture.Label },
                right: { kind: PolicyNodeKind.Literal, value: label },
            },
        }]
        this.WritePolicy(app, JSON.stringify({ [concept]: rules }))
    }

    /** Starts a Runtime server over the seeded dirs and returns a function producing connected clients. */
    public async Runtime(): Promise<() => PragmaticClient>
    {
        const server = new PragmaticServer({ packagesRoot: this.Packages, applicationsRoot: this.Apps, purpose: TenantPurpose.Runtime })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        this.disposables.push(async () =>
        {
            await (languageService as SolutionLanguageService).WhenIdle()
            await server.Dispose()
        })
        return () => this.Connect(server, languageService, manager, TenantPurpose.Runtime)
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
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        this.disposables.push(async () =>
        {
            await (languageService as SolutionLanguageService).WhenIdle()
            await manager.CloseSolution()
            await server.Dispose()
            rmSync(solution, { recursive: true, force: true })
        })
        return this.Connect(server, languageService, manager, TenantPurpose.Development)
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

    public static Column(result: { rows: unknown[][] }): unknown[]
    {
        return result.rows.map(r => r[0]).sort()
    }

    private Connect(server: PragmaticServer, languageService: Awaited<ReturnType<PragmaticServer['LanguageService']>>, manager: Awaited<ReturnType<PragmaticServer['Manager']>>, purpose: TenantPurpose): PragmaticClient
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const runtime = purpose === TenantPurpose.Runtime
        const handler = ServerConnectionHandler.Attach(
            serverSocket, languageService, manager, RuntimeSurfaceFixture.Permissive(),
            () => Promise.reject(new Error(RuntimeSurfaceFixture.NoConnectors)), ctx => server.Graph(ctx),
            undefined, undefined, undefined, undefined, undefined, undefined, purpose,
            runtime ? server.Applications() : undefined,
            runtime ? (ctx, name, labels) => server.GraphForPragmaticApp(ctx, name, labels) : undefined)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        this.disposables.push(async () =>
        {
            await client.DisposeAsync()
            handler.Dispose()
        })
        return client
    }
}

test('runtime e2e: list, open and query an application', async () =>
{
    await RuntimeSurfaceFixture.Run(async fx =>
    {
        await fx.Seed(RuntimeSurfaceFixture.AppA, RuntimeSurfaceFixture.PkgA, RuntimeSurfaceFixture.Widget, [RuntimeSurfaceFixture.Hi, RuntimeSurfaceFixture.Bye], true)
        const client = (await fx.Runtime())()
        const apps = await client.ListApplications()
        assert.ok(apps.some(a => a.name === RuntimeSurfaceFixture.AppA))
        const summary = await client.OpenApplication(RuntimeSurfaceFixture.AppA)
        assert.equal(summary.name, RuntimeSurfaceFixture.AppA)
        assert.equal(summary.version, RuntimeSurfaceFixture.Version)
        const result = await client.CypherQuery(RuntimeSurfaceFixture.WidgetLabels)
        assert.deepEqual(RuntimeSurfaceFixture.Column(result), [RuntimeSurfaceFixture.Bye, RuntimeSurfaceFixture.Hi])
    })
})

test('runtime e2e: query before opening an application is rejected', async () =>
{
    await RuntimeSurfaceFixture.Run(async fx =>
    {
        await fx.Seed(RuntimeSurfaceFixture.AppA, RuntimeSurfaceFixture.PkgA, RuntimeSurfaceFixture.Widget, [RuntimeSurfaceFixture.Hi], false)
        const client = (await fx.Runtime())()
        await assert.rejects(() => client.CypherQuery(RuntimeSurfaceFixture.WidgetLabels), RuntimeSurfaceFixture.NoAppSelected)
    })
})

test('runtime e2e: runtime tenant rejects solution/open (cross-purpose)', async () =>
{
    await RuntimeSurfaceFixture.Run(async fx =>
    {
        const client = (await fx.Runtime())()
        await assert.rejects(() => client.OpenSolution(fx.Packages), RuntimeSurfaceFixture.NotDevelopment)
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

test('runtime e2e: access policy hides instances and edges, is live, and fails closed when malformed', async () =>
{
    await RuntimeSurfaceFixture.Run(async fx =>
    {
        await fx.Seed(RuntimeSurfaceFixture.AppA, RuntimeSurfaceFixture.PkgA, RuntimeSurfaceFixture.Widget, [RuntimeSurfaceFixture.Hi, RuntimeSurfaceFixture.Bye], true)
        const client = (await fx.Runtime())()
        await client.OpenApplication(RuntimeSurfaceFixture.AppA)
        const before = await client.CypherQuery(RuntimeSurfaceFixture.EdgeQuery)
        assert.equal(before.rows.length, 1)

        fx.DenyLabel(RuntimeSurfaceFixture.AppA, RuntimeSurfaceFixture.Widget, RuntimeSurfaceFixture.Bye)
        const denied = await client.CypherQuery(RuntimeSurfaceFixture.WidgetLabels)
        assert.deepEqual(RuntimeSurfaceFixture.Column(denied), [RuntimeSurfaceFixture.Hi])
        const edges = await client.CypherQuery(RuntimeSurfaceFixture.EdgeQuery)
        assert.equal(edges.rows.length, 0)

        fx.WritePolicy(RuntimeSurfaceFixture.AppA, RuntimeSurfaceFixture.OpenPolicy)
        const open = await client.CypherQuery(RuntimeSurfaceFixture.WidgetLabels)
        assert.deepEqual(RuntimeSurfaceFixture.Column(open), [RuntimeSurfaceFixture.Bye, RuntimeSurfaceFixture.Hi])
        const reopenedEdges = await client.CypherQuery(RuntimeSurfaceFixture.EdgeQuery)
        assert.equal(reopenedEdges.rows.length, 1)

        fx.WritePolicy(RuntimeSurfaceFixture.AppA, RuntimeSurfaceFixture.MalformedPolicy)
        await assert.rejects(() => client.CypherQuery(RuntimeSurfaceFixture.WidgetLabels), RuntimeSurfaceFixture.MalformedPolicyMessage)
    })
})

test('runtime e2e: each connection sees only its own bound application', async () =>
{
    await RuntimeSurfaceFixture.Run(async fx =>
    {
        await fx.Seed(RuntimeSurfaceFixture.AppA, RuntimeSurfaceFixture.PkgA, RuntimeSurfaceFixture.Widget, [RuntimeSurfaceFixture.Hi, RuntimeSurfaceFixture.Bye], false)
        await fx.Seed(RuntimeSurfaceFixture.AppB, RuntimeSurfaceFixture.PkgB, RuntimeSurfaceFixture.Gadget, [RuntimeSurfaceFixture.Cog], false)
        const connect = await fx.Runtime()
        const one = connect()
        const two = connect()
        await one.OpenApplication(RuntimeSurfaceFixture.AppA)
        await two.OpenApplication(RuntimeSurfaceFixture.AppB)
        assert.deepEqual(RuntimeSurfaceFixture.Column(await one.CypherQuery(RuntimeSurfaceFixture.WidgetLabels)), [RuntimeSurfaceFixture.Bye, RuntimeSurfaceFixture.Hi])
        await assert.rejects(() => one.CypherQuery(RuntimeSurfaceFixture.GadgetLabels), RuntimeSurfaceFixture.UnknownLabel)
        assert.deepEqual(RuntimeSurfaceFixture.Column(await two.CypherQuery(RuntimeSurfaceFixture.GadgetLabels)), [RuntimeSurfaceFixture.Cog])
        await assert.rejects(() => two.CypherQuery(RuntimeSurfaceFixture.WidgetLabels), RuntimeSurfaceFixture.UnknownLabel)
    })
})

test('runtime e2e: same-named concepts in two applications do not leak instances across connections', async () =>
{
    await RuntimeSurfaceFixture.Run(async fx =>
    {
        await fx.Seed(RuntimeSurfaceFixture.AppA, RuntimeSurfaceFixture.PkgA, RuntimeSurfaceFixture.Widget, [RuntimeSurfaceFixture.Hi, RuntimeSurfaceFixture.Bye], false)
        await fx.Seed(RuntimeSurfaceFixture.AppB, RuntimeSurfaceFixture.PkgB, RuntimeSurfaceFixture.Widget, [RuntimeSurfaceFixture.Nut, RuntimeSurfaceFixture.Bolt], false)
        const connect = await fx.Runtime()
        const one = connect()
        const two = connect()
        await one.OpenApplication(RuntimeSurfaceFixture.AppA)
        await two.OpenApplication(RuntimeSurfaceFixture.AppB)
        assert.deepEqual(RuntimeSurfaceFixture.Column(await one.CypherQuery(RuntimeSurfaceFixture.WidgetLabels)), [RuntimeSurfaceFixture.Bye, RuntimeSurfaceFixture.Hi])
        assert.deepEqual(RuntimeSurfaceFixture.Column(await two.CypherQuery(RuntimeSurfaceFixture.WidgetLabels)), [RuntimeSurfaceFixture.Bolt, RuntimeSurfaceFixture.Nut])
    })
})

test('runtime e2e: open rejects a manifest whose name differs from its directory', async () =>
{
    await RuntimeSurfaceFixture.Run(async fx =>
    {
        await fx.Seed(RuntimeSurfaceFixture.AppA, RuntimeSurfaceFixture.PkgA, RuntimeSurfaceFixture.Widget, [RuntimeSurfaceFixture.Hi], false)
        fx.RenameManifest(RuntimeSurfaceFixture.AppA, RuntimeSurfaceFixture.Renamed)
        const client = (await fx.Runtime())()
        await assert.rejects(() => client.OpenApplication(RuntimeSurfaceFixture.AppA), RuntimeSurfaceFixture.NameMismatch)
    })
})
