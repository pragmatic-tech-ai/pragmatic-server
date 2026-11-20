import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, SolutionProtocol, BuildState, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/pragmatic-identity'
import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { GraphBuildState } from '@pragmatic-tech-ai/todl'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'
import type { IDevGraphService } from '../graphs/dev-graph-service.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { AuthoringTarget } from '../solutions/authoring-target.js'
import { EnvSolutionRoots } from '../solutions/env-solution-roots.js'
import { MemoryStorageRegistry } from '../solutions/tests/memory-storage-registry.js'

class AuthoringFixture
{
    public static readonly ActiveName = 'sol-active'
    public static readonly OtherA = 'sol-a'
    public static readonly OtherB = 'sol-b'
    public static readonly Unknown = 'sol-unknown'
    public static readonly MemberPath = 'app/app.todl'
    public static readonly MemberType = 'todl'
    private static readonly Area = 'env/src'
    private static readonly ManifestSuffix = '.pksln'
    private static readonly ManifestKindKey = 'kind'
    private static readonly ManifestKind = 'todl-solution'
    private static readonly ManifestVersionKey = 'version'
    private static readonly ManifestVersion = 1
    private static readonly NameKey = 'name'
    private static readonly MembersKey = 'members'
    private static readonly SettingsKey = 'settings'
    private static readonly EnvironmentId = 't1'
    private static readonly PrincipalId = 'p1'
    private static readonly EnvironmentName = 'Environment One'

    public static Context(role: Role): AccessContext
    {
        const realm = new Realm(AuthoringFixture.EnvironmentId, RealmKind.SelfHosted, AuthoringFixture.EnvironmentName)
        const principal = new Principal(AuthoringFixture.PrincipalId, AuthoringFixture.EnvironmentId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(AuthoringFixture.PrincipalId, role, new ResourceRef(ResourceKind.Realm, AuthoringFixture.EnvironmentId, []))]
        return new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy())
    }

    public static Graphs(ids: string[]): IDevGraphService
    {
        return { ListSolutionIds: async () => ids } as unknown as IDevGraphService
    }

    /** Named solutions on disk (default OtherA and OtherB); only OtherA has a member. */
    public static async Roots(names: string[] = [AuthoringFixture.OtherA, AuthoringFixture.OtherB]): Promise<EnvSolutionRoots>
    {
        const registry = new MemoryStorageRegistry()
        const area = registry.CreateStorage(AuthoringFixture.Area)
        for (const name of names)
        {
            const members = name === AuthoringFixture.OtherA ? [{ path: AuthoringFixture.MemberPath, type: AuthoringFixture.MemberType }] : []
            const manifest = { [AuthoringFixture.ManifestKindKey]: AuthoringFixture.ManifestKind, [AuthoringFixture.ManifestVersionKey]: AuthoringFixture.ManifestVersion, [AuthoringFixture.NameKey]: name, [AuthoringFixture.MembersKey]: members, [AuthoringFixture.SettingsKey]: {} }
            await registry.CreateStorage(AuthoringFixture.Area + '/' + name).WriteText(name + AuthoringFixture.ManifestSuffix, JSON.stringify(manifest))
            await area.CreateDirectory(name)
        }
        const roots = new EnvSolutionRoots(AuthoringFixture.Area, registry)
        await roots.Refresh()
        return roots
    }

    public static Language(): ILanguageService
    {
        const signal = { subscribe: () => ({ dispose: () => undefined }) }
        return { GraphChanged: signal, BuildStateChanged: signal, BuildState: GraphBuildState.Ready } as unknown as ILanguageService
    }

    public static Manager(): SolutionManagerService
    {
        const solution = { Name: AuthoringFixture.ActiveName, Members: { ToArray: () => [] } }
        return { ActiveSolution: solution } as unknown as SolutionManagerService
    }

    public static Attach(manager: SolutionManagerService, role: Role = Role.Owner, purpose: EnvironmentPurpose = EnvironmentPurpose.Development, graphs?: IDevGraphService, solutionRoots?: EnvSolutionRoots): { handler: ServerConnectionHandler; client: MessageConnection }
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, AuthoringFixture.Language(), manager, AuthoringFixture.Context(role), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, purpose, undefined, undefined, undefined, undefined, undefined, graphs, undefined, undefined, undefined, undefined, undefined, solutionRoots)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        return { handler, client }
    }
}

test('AuthoringTarget defaults to the fallback id and an explicit Select overrides it', () =>
{
    const target = new AuthoringTarget(() => AuthoringFixture.ActiveName)
    assert.equal(target.SolutionId, AuthoringFixture.ActiveName)
    target.Select(AuthoringFixture.OtherA)
    assert.equal(target.SolutionId, AuthoringFixture.OtherA)
})

test('selectAuthoring on one connection leaves the other connection and the global ActiveSolution untouched', async () =>
{
    const manager = AuthoringFixture.Manager()
    const globalBefore = manager.ActiveSolution
    const a = AuthoringFixture.Attach(manager)
    const b = AuthoringFixture.Attach(manager)
    try
    {
        assert.equal(b.handler.Authoring.SolutionId, AuthoringFixture.ActiveName)
        await a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherA })
        assert.equal(a.handler.Authoring.SolutionId, AuthoringFixture.OtherA)
        assert.equal(b.handler.Authoring.SolutionId, AuthoringFixture.ActiveName)
        await b.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherB })
        assert.equal(a.handler.Authoring.SolutionId, AuthoringFixture.OtherA)
        assert.equal(b.handler.Authoring.SolutionId, AuthoringFixture.OtherB)
        assert.equal(manager.ActiveSolution, globalBefore)
    }
    finally
    {
        a.client.dispose()
        b.client.dispose()
        a.handler.Dispose()
        b.handler.Dispose()
    }
})

test('solution/list returns the current solution', async () =>
{
    const manager = AuthoringFixture.Manager()
    const a = AuthoringFixture.Attach(manager)
    try
    {
        const list = await a.client.sendRequest(SolutionProtocol.ListSolutions)
        assert.deepEqual(list, [{ Name: AuthoringFixture.ActiveName, Id: AuthoringFixture.ActiveName }])
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('solution/list is the union of the current solution and the graph service slice ids', async () =>
{
    const graphs = AuthoringFixture.Graphs([AuthoringFixture.OtherA, AuthoringFixture.ActiveName, AuthoringFixture.OtherB])
    const a = AuthoringFixture.Attach(AuthoringFixture.Manager(), Role.Owner, EnvironmentPurpose.Development, graphs)
    try
    {
        const list = await a.client.sendRequest(SolutionProtocol.ListSolutions)
        assert.deepEqual(list.map(s => s.Id), [AuthoringFixture.ActiveName, AuthoringFixture.OtherA, AuthoringFixture.OtherB])
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('selectAuthoring for a non-current id reports no members and a neutral build state', async () =>
{
    const a = AuthoringFixture.Attach(AuthoringFixture.Manager())
    try
    {
        const summary = await a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherA })
        assert.equal(summary.name, AuthoringFixture.OtherA)
        assert.deepEqual(summary.members, [])
        assert.equal(summary.buildState, BuildState.Building)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('a Viewer may list solutions but is denied selectAuthoring (Read vs Write)', async () =>
{
    const manager = AuthoringFixture.Manager()
    const a = AuthoringFixture.Attach(manager, Role.Viewer)
    try
    {
        const list = await a.client.sendRequest(SolutionProtocol.ListSolutions)
        assert.equal(list.length, 1)
        await assert.rejects(() => a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherA }))
        assert.equal(a.handler.Authoring.SolutionId, AuthoringFixture.ActiveName)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('a Runtime environment does not register solution/list or solution/selectAuthoring', async () =>
{
    const a = AuthoringFixture.Attach(AuthoringFixture.Manager(), Role.Owner, EnvironmentPurpose.Runtime)
    try
    {
        await assert.rejects(() => a.client.sendRequest(SolutionProtocol.ListSolutions), (e: { code?: number }) => e.code === ErrorCodes.MethodNotFound)
        await assert.rejects(() => a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherA }), (e: { code?: number }) => e.code === ErrorCodes.MethodNotFound)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('selectAuthoring rejects a non-string SolutionId with InvalidParams', async () =>
{
    const a = AuthoringFixture.Attach(AuthoringFixture.Manager())
    try
    {
        await assert.rejects(() => a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: 42 } as never), (e: { code?: number }) => e.code === ErrorCodes.InvalidParams)
        await assert.rejects(() => a.client.sendRequest(SolutionProtocol.SelectAuthoring, {} as never), (e: { code?: number }) => e.code === ErrorCodes.InvalidParams)
        assert.equal(a.handler.Authoring.SolutionId, AuthoringFixture.ActiveName)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('with named solutions composed, solution/list includes them and selectAuthoring reports real members and the composed build state for a non-current one', async () =>
{
    const roots = await AuthoringFixture.Roots()
    const a = AuthoringFixture.Attach(AuthoringFixture.Manager(), Role.Owner, EnvironmentPurpose.Development, undefined, roots)
    try
    {
        const list = await a.client.sendRequest(SolutionProtocol.ListSolutions)
        assert.deepEqual(list.map(s => s.Id), [AuthoringFixture.ActiveName, AuthoringFixture.OtherA, AuthoringFixture.OtherB])
        const summary = await a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherA })
        assert.equal(summary.name, AuthoringFixture.OtherA)
        assert.deepEqual(summary.members, [{ id: AuthoringFixture.MemberPath, type: AuthoringFixture.MemberType }])
        assert.equal(summary.buildState, BuildState.Ready)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('selectAuthoring for an id unknown to the solution roots keeps the neutral placeholder', async () =>
{
    const roots = await AuthoringFixture.Roots()
    const a = AuthoringFixture.Attach(AuthoringFixture.Manager(), Role.Owner, EnvironmentPurpose.Development, undefined, roots)
    try
    {
        const summary = await a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.Unknown })
        assert.deepEqual(summary.members, [])
        assert.equal(summary.buildState, BuildState.Building)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('an active solution that is also a named root appears exactly once in solution/list', async () =>
{
    const roots = await AuthoringFixture.Roots([AuthoringFixture.ActiveName, AuthoringFixture.OtherA])
    const a = AuthoringFixture.Attach(AuthoringFixture.Manager(), Role.Owner, EnvironmentPurpose.Development, undefined, roots)
    try
    {
        const list = await a.client.sendRequest(SolutionProtocol.ListSolutions)
        assert.deepEqual(list.map(s => s.Id), [AuthoringFixture.ActiveName, AuthoringFixture.OtherA])
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('without solution roots a non-active id falls back to empty members and Building', async () =>
{
    const a = AuthoringFixture.Attach(AuthoringFixture.Manager(), Role.Owner, EnvironmentPurpose.Development, undefined, undefined)
    try
    {
        const summary = await a.client.sendRequest(SolutionProtocol.SelectAuthoring, { SolutionId: AuthoringFixture.OtherA })
        assert.deepEqual(summary.members, [])
        assert.equal(summary.buildState, BuildState.Building)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})
