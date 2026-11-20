import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, SolutionProtocol, StorageProtocol, GraphProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IMessageSocket, MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/pragmatic-identity'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import type { IDevGraphService } from '../graphs/dev-graph-service.js'
import type { EnvSolutionRoots } from '../solutions/env-solution-roots.js'

class UploadFixture
{
    public static readonly TempPrefix = 'upload-composition-'
    public static readonly NameA = 'sol-a'
    public static readonly NameB = 'sol-b'
    public static readonly GraphName = 'g1'
    public static readonly GraphDescription = ''
    public static readonly MemberType = 'meta-model'
    public static readonly ManifestSuffix = '.pksln'
    public static readonly ProjectFile = 'project.plexus'
    public static readonly ModelFile = 'model.todl'
    public static readonly PackageA = 'pkg-a'
    public static readonly PackageB = 'pkg-b'
    public static readonly PackageVersion = '1.0.0'
    public static readonly ModelJson = '{}'
    public static readonly EnvironmentId = 't1'
    public static readonly PrincipalId = 'p1'
    public static readonly Display = 'Environment One'
    public static readonly SolutionsDir = 'solutions'
    public static readonly PackagesDir = 'packages'
    public static readonly GraphsDir = 'graphs'
    public static readonly ApplicationsDir = 'applications'
    public static readonly PathSeparator = '/'
    private static readonly SettleAttempts = 100
    private static readonly SettleDelayMs = 20
    private static readonly MemberSuffix = '-models'
    private static readonly ManifestKind = 'todl-solution'
    private static readonly ManifestVersion = 1
    private static readonly ProjectVersion = '0.1.0'
    private static readonly NamespacePrefix = 'ns_'
    private static readonly ConceptPrefix = 'Widget_'
    private static readonly Dash = '-'
    private static readonly Underscore = '_'
    private static readonly Dot = '.'

    public static MemberDir(name: string): string
    {
        return name + UploadFixture.MemberSuffix
    }

    public static MemberFile(name: string, file: string): string
    {
        return UploadFixture.MemberDir(name) + UploadFixture.PathSeparator + file
    }

    /** The fully qualified entity id the solution's model declares. */
    public static EntityId(name: string): string
    {
        const suffix = UploadFixture.Suffix(name)
        return UploadFixture.NamespacePrefix + suffix + UploadFixture.Dot + UploadFixture.ConceptPrefix + suffix
    }

    public static Manifest(name: string): string
    {
        return JSON.stringify({ kind: UploadFixture.ManifestKind, version: UploadFixture.ManifestVersion, name, members: [{ path: UploadFixture.MemberDir(name), type: UploadFixture.MemberType }], settings: {} })
    }

    public static ProjectText(name: string): string
    {
        return JSON.stringify({ type: UploadFixture.MemberType, name, id: UploadFixture.MemberDir(name), packageVersion: UploadFixture.ProjectVersion })
    }

    public static ModelText(name: string): string
    {
        const suffix = UploadFixture.Suffix(name)
        return 'namespace ' + UploadFixture.NamespacePrefix + suffix + ' { concept ' + UploadFixture.ConceptPrefix + suffix + ' { } }'
    }

    public static Context(): AccessContext
    {
        const realm = new Realm(UploadFixture.EnvironmentId, RealmKind.SelfHosted, UploadFixture.Display)
        const principal = new Principal(UploadFixture.PrincipalId, UploadFixture.EnvironmentId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(UploadFixture.PrincipalId, Role.Developer, new ResourceRef(ResourceKind.Realm, UploadFixture.EnvironmentId, []))]
        return new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy())
    }

    /** Attaches a develop-purpose connection handler; only the language service, graphs and solution roots matter to this flow. */
    public static AttachHandler(socket: IMessageSocket, language: ILanguageService, manager: SolutionManagerService, graphs: IDevGraphService, roots: EnvSolutionRoots): ServerConnectionHandler
    {
        return ServerConnectionHandler.Attach(socket, language, manager, UploadFixture.Context(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, EnvironmentPurpose.Development, undefined, undefined, undefined, undefined, undefined, graphs, undefined, undefined, undefined, undefined, undefined, roots)
    }

    /** The model view once it declares every wanted entity (the live recompose is queued, not synchronous); the last view if it never does. */
    public static async SettledView(language: ILanguageService, consumer: IStorage, wanted: readonly string[]): Promise<Awaited<ReturnType<ILanguageService['ModelView']>>>
    {
        let view = await language.ModelView(consumer)
        for (let attempt = 0; attempt < UploadFixture.SettleAttempts && !(view !== undefined && wanted.every(id => view!.model.has(id))); attempt++)
        {
            await new Promise(resolve => setTimeout(resolve, UploadFixture.SettleDelayMs))
            view = await language.ModelView(consumer)
        }
        return view
    }

    /** Creates the solution, seeds its tree through storage/*, and contributes its graph slice. */
    public static async Upload(client: MessageConnection, name: string, packageId: string): Promise<void>
    {
        await client.sendRequest(SolutionProtocol.CreateSolution, { Name: name })
        await client.sendRequest(StorageProtocol.WriteText, { Path: name + UploadFixture.ManifestSuffix, Content: UploadFixture.Manifest(name) })
        await client.sendRequest(StorageProtocol.CreateDirectory, { Path: UploadFixture.MemberDir(name) })
        await client.sendRequest(StorageProtocol.WriteText, { Path: UploadFixture.MemberFile(name, UploadFixture.ProjectFile), Content: UploadFixture.ProjectText(name) })
        await client.sendRequest(StorageProtocol.WriteText, { Path: UploadFixture.MemberFile(name, UploadFixture.ModelFile), Content: UploadFixture.ModelText(name) })
        await client.sendRequest(GraphProtocol.Contribute, { graphName: UploadFixture.GraphName, solutionId: name, packages: [{ id: packageId, version: UploadFixture.PackageVersion, modelJson: UploadFixture.ModelJson }] })
    }

    /** True when `inner` is strictly inside `outer` (platform-correct, via path.relative). */
    public static Contains(outer: string, inner: string): boolean
    {
        const rel = relative(outer, inner)
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    }

    public static async Exists(path: string): Promise<boolean>
    {
        try
        {
            await stat(path)
            return true
        }
        catch
        {
            return false
        }
    }

    private static Suffix(name: string): string
    {
        return name.replace(UploadFixture.Dash, UploadFixture.Underscore)
    }
}

test('two uploaded solutions compose live: disjoint roots, both listed, real members each, language service composes both, graph slices unioned, A survives B becoming active', async () =>
{
    const base = await mkdtemp(join(tmpdir(), UploadFixture.TempPrefix))
    const solutionsRoot = join(base, UploadFixture.SolutionsDir)
    const server = new PragmaticServer({ purpose: EnvironmentPurpose.Development, packagesRoot: join(base, UploadFixture.PackagesDir), graphsRoot: join(base, UploadFixture.GraphsDir), applicationsRoot: join(base, UploadFixture.ApplicationsDir), solutionsRoot })
    try
    {
        await server.Start()
        const manager = await server.Manager()
        const roots = await server.DevSolutionRoots()
        const graphs = server.GraphService()
        const language = await server.LanguageService()
        await graphs.CreateGraph({ graphName: UploadFixture.GraphName, description: UploadFixture.GraphDescription })
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = UploadFixture.AttachHandler(serverSocket, language, manager, graphs, roots)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        try
        {
            await UploadFixture.Upload(client, UploadFixture.NameA, UploadFixture.PackageA)
            assert.equal(manager.ActiveSolution?.Name, UploadFixture.NameA)
            await UploadFixture.Upload(client, UploadFixture.NameB, UploadFixture.PackageB)

            // The active solution switched to B, but A is still on disk and composed (read-only loader: no eviction).
            assert.equal(manager.ActiveSolution?.Name, UploadFixture.NameB)
            const rootA = join(solutionsRoot, UploadFixture.NameA)
            const rootB = join(solutionsRoot, UploadFixture.NameB)
            assert.ok((await stat(rootA)).isDirectory())
            assert.ok((await stat(rootB)).isDirectory())
            assert.ok(!UploadFixture.Contains(rootA, rootB) && !UploadFixture.Contains(rootB, rootA) && relative(rootA, rootB) !== '')
            assert.ok(await UploadFixture.Exists(join(rootA, UploadFixture.MemberFile(UploadFixture.NameA, UploadFixture.ModelFile))))
            assert.ok(await UploadFixture.Exists(join(rootB, UploadFixture.MemberFile(UploadFixture.NameB, UploadFixture.ModelFile))))
            assert.ok(!(await UploadFixture.Exists(join(rootB, UploadFixture.MemberFile(UploadFixture.NameA, UploadFixture.ModelFile)))))
            assert.ok(!(await UploadFixture.Exists(join(rootA, UploadFixture.MemberFile(UploadFixture.NameB, UploadFixture.ModelFile)))))

            const listed = (await client.sendRequest(SolutionProtocol.ListSolutions) as { Name: string }[]).map(s => s.Name).sort()
            assert.deepEqual(listed, [UploadFixture.NameA, UploadFixture.NameB])

            // Ruling T10 closed: the manifest write refreshed the roots cache and the active solution's own members live (no manual Refresh).
            const summaryB = await client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: UploadFixture.NameB }) as { members: { id: string; type: string }[] }
            assert.deepEqual(summaryB.members, [{ id: UploadFixture.MemberDir(UploadFixture.NameB), type: UploadFixture.MemberType }])
            // A (non-active) reports its real manifest members.
            const summaryA = await client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: UploadFixture.NameA }) as { members: { id: string; type: string }[] }
            assert.deepEqual(summaryA.members, [{ id: UploadFixture.MemberDir(UploadFixture.NameA), type: UploadFixture.MemberType }])
            assert.deepEqual(roots.MembersOf(UploadFixture.NameB).map(m => m.Ref.path), [UploadFixture.MemberDir(UploadFixture.NameB)])
            // Selecting an authoring target never moves the global active solution.
            assert.equal(manager.ActiveSolution?.Name, UploadFixture.NameB)
            assert.equal(handler.Authoring.Selected, UploadFixture.NameA)

            const composed = manager.ComposedMembers()
            assert.deepEqual(composed.map(m => m.Ref.path).sort(), [UploadFixture.MemberDir(UploadFixture.NameA), UploadFixture.MemberDir(UploadFixture.NameB)])

            // The language service consumes ComposedMembers: its shared model must declare BOTH solutions' entities.
            // The recompose is asynchronous (queued on the language service), so wait for it to settle rather than for a manual Refresh.
            const view = await UploadFixture.SettledView(language, composed[0].Storage!, [UploadFixture.EntityId(UploadFixture.NameA), UploadFixture.EntityId(UploadFixture.NameB)])
            assert.ok(view !== undefined)
            assert.ok(view.model.has(UploadFixture.EntityId(UploadFixture.NameA)))
            assert.ok(view.model.has(UploadFixture.EntityId(UploadFixture.NameB)))

            const graph = await graphs.GetGraph({ graphName: UploadFixture.GraphName })
            assert.deepEqual(graph.packages.map(p => p.id).sort(), [UploadFixture.PackageA, UploadFixture.PackageB])
        }
        finally
        {
            client.dispose()
            handler.Dispose()
        }
    }
    finally
    {
        await server.Dispose()
        await rm(base, { recursive: true, force: true })
    }
})
