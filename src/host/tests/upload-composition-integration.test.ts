import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, SolutionProtocol, StorageProtocol, GraphProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'

class UploadFixture
{
    public static readonly TempPrefix = 'upload-composition-'
    public static readonly NameA = 'sol-a'
    public static readonly NameB = 'sol-b'
    public static readonly GraphName = 'g1'
    public static readonly MemberType = 'todl'
    public static readonly ManifestSuffix = '.pksln'
    public static readonly TodlFile = 'app.todl'
    public static readonly TodlText = 'package demo;'
    public static readonly PackageA = 'pkg-a'
    public static readonly PackageB = 'pkg-b'
    public static readonly PackageVersion = '1.0.0'
    public static readonly EnvironmentId = 't1'
    public static readonly PrincipalId = 'p1'
    public static readonly Display = 'Environment One'
    private static readonly ManifestKind = 'todl-solution'
    private static readonly ManifestVersion = 1

    public static MemberDir(name: string): string
    {
        return name + '-app'
    }

    public static MemberPath(name: string): string
    {
        return UploadFixture.MemberDir(name) + '/' + UploadFixture.TodlFile
    }

    public static Manifest(name: string): string
    {
        return JSON.stringify({ kind: UploadFixture.ManifestKind, version: UploadFixture.ManifestVersion, name, members: [{ path: UploadFixture.MemberPath(name), type: UploadFixture.MemberType }], settings: {} })
    }

    public static Context(): AccessContext
    {
        const realm = new Realm(UploadFixture.EnvironmentId, RealmKind.SelfHosted, UploadFixture.Display)
        const principal = new Principal(UploadFixture.PrincipalId, UploadFixture.EnvironmentId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(UploadFixture.PrincipalId, Role.Developer, new ResourceRef(ResourceKind.Realm, UploadFixture.EnvironmentId, []))]
        return new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy())
    }

    /** Creates the solution, seeds its tree through storage/*, and contributes its graph slice. */
    public static async Upload(client: MessageConnection, name: string, packageId: string): Promise<void>
    {
        await client.sendRequest(SolutionProtocol.CreateSolution, { Name: name })
        await client.sendRequest(StorageProtocol.WriteText, { Path: name + UploadFixture.ManifestSuffix, Content: UploadFixture.Manifest(name) })
        await client.sendRequest(StorageProtocol.CreateDirectory, { Path: UploadFixture.MemberDir(name) })
        await client.sendRequest(StorageProtocol.WriteText, { Path: UploadFixture.MemberPath(name), Content: UploadFixture.TodlText })
        await client.sendRequest(GraphProtocol.Contribute, { graphName: UploadFixture.GraphName, solutionId: name, packages: [{ id: packageId, version: UploadFixture.PackageVersion, modelJson: '{}' }] })
    }
}

test('two uploaded solutions compose live: disjoint roots, both listed, real members each, graph slices unioned, A survives B becoming active', async () =>
{
    const base = await mkdtemp(join(tmpdir(), UploadFixture.TempPrefix))
    const solutionsRoot = join(base, 'solutions')
    const server = new PragmaticServer({ purpose: EnvironmentPurpose.Development, packagesRoot: join(base, 'packages'), graphsRoot: join(base, 'graphs'), applicationsRoot: join(base, 'applications'), solutionsRoot })
    try
    {
        await server.Start()
        const manager = await server.Manager()
        const roots = await server.DevSolutionRoots()
        const graphs = server.GraphService()
        await graphs.CreateGraph({ graphName: UploadFixture.GraphName, description: '' })
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, await server.LanguageService(), manager, UploadFixture.Context(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, EnvironmentPurpose.Development, undefined, undefined, undefined, undefined, undefined, graphs, undefined, undefined, undefined, undefined, undefined, roots)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        try
        {
            await UploadFixture.Upload(client, UploadFixture.NameA, UploadFixture.PackageA)
            assert.equal(manager.ActiveSolution?.Name, UploadFixture.NameA)
            await roots.Refresh()
            await UploadFixture.Upload(client, UploadFixture.NameB, UploadFixture.PackageB)
            await roots.Refresh()

            assert.equal(manager.ActiveSolution?.Name, UploadFixture.NameB)
            const rootA = join(solutionsRoot, UploadFixture.NameA)
            const rootB = join(solutionsRoot, UploadFixture.NameB)
            assert.ok((await stat(rootA)).isDirectory())
            assert.ok((await stat(rootB)).isDirectory())
            assert.ok(!rootA.startsWith(rootB + '/') && !rootB.startsWith(rootA + '/') && rootA !== rootB)
            assert.ok((await stat(join(rootA, UploadFixture.MemberPath(UploadFixture.NameA)))).isFile())
            assert.ok((await stat(join(rootB, UploadFixture.MemberPath(UploadFixture.NameB)))).isFile())

            const listed = (await client.sendRequest(SolutionProtocol.ListSolutions) as { Name: string }[]).map(s => s.Name)
            assert.ok(listed.includes(UploadFixture.NameA))
            assert.ok(listed.includes(UploadFixture.NameB))

            const summaryA = await client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: UploadFixture.NameA }) as { members: { id: string; type: string }[] }
            assert.deepEqual(summaryA.members, [{ id: UploadFixture.MemberPath(UploadFixture.NameA), type: UploadFixture.MemberType }])
            assert.deepEqual(roots.MembersOf(UploadFixture.NameB).map(m => m.Ref.path), [UploadFixture.MemberPath(UploadFixture.NameB)])

            const composed = manager.ComposedMembers().map(m => m.Ref.path).sort()
            assert.deepEqual(composed, [UploadFixture.MemberPath(UploadFixture.NameA), UploadFixture.MemberPath(UploadFixture.NameB)])

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
