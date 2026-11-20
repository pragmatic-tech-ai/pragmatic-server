import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryMessageSocket, WebSocketMessageReader, WebSocketMessageWriter, createMessageConnection, NullLogger, StorageProtocol, SolutionProtocol, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/pragmatic-identity'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { GraphBuildState } from '@pragmatic-tech-ai/todl'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { EnvSolutionRoots } from '../../solutions/env-solution-roots.js'
import { MemoryStorageRegistry } from '../../solutions/tests/memory-storage-registry.js'
import { EnvironmentPurpose } from '../../../environments/environment-purpose.js'
import { SourceChangeBridge } from '../../solutions/source-change-bridge.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'

class RegistrationFixture
{
    private static readonly EnvironmentId = 't1'
    private static readonly PrincipalId = 'p1'
    private static readonly EnvironmentName = 'Environment One'

    public static Context(role: Role | undefined): AccessContext
    {
        const realm = new Realm(RegistrationFixture.EnvironmentId, RealmKind.SelfHosted, RegistrationFixture.EnvironmentName)
        const principal = new Principal(RegistrationFixture.PrincipalId, RegistrationFixture.EnvironmentId, PrincipalKind.User, new Map(), [])
        const grants = role === undefined ? [] : [new Grant(RegistrationFixture.PrincipalId, role, new ResourceRef(ResourceKind.Realm, RegistrationFixture.EnvironmentId, []))]
        return new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy())
    }

    public static Language(): ILanguageService
    {
        const signal = { subscribe: () => ({ dispose: () => undefined }) }
        return { GraphChanged: signal, BuildStateChanged: signal, BuildState: GraphBuildState.Ready, DidChange: () => undefined } as unknown as ILanguageService
    }

    public static Manager(): SolutionManagerService
    {
        return { ActiveSolution: { Name: 'sol', Storage: new FakeStorage(), Members: { ToArray: () => [] } } } as unknown as SolutionManagerService
    }

    public static Attach(purpose: EnvironmentPurpose, role: Role = Role.Owner): { handler: ServerConnectionHandler; client: MessageConnection }
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, RegistrationFixture.Language(), RegistrationFixture.Manager(), RegistrationFixture.Context(role), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, purpose)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        return { handler, client }
    }
}

test('a Development environment serves storage/* over the wire', async () =>
{
    const a = RegistrationFixture.Attach(EnvironmentPurpose.Development)
    try
    {
        await a.client.sendRequest(StorageProtocol.WriteText, { Path: 'a/x.todl', Content: 'hi' })
        assert.deepEqual(await a.client.sendRequest(StorageProtocol.ReadText, { Path: 'a/x.todl' }), { Content: 'hi' })
        assert.deepEqual(await a.client.sendRequest(StorageProtocol.List, { Path: 'a' }), [{ Name: 'x.todl', IsDirectory: false }])
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('a Runtime environment does not register storage/*', async () =>
{
    const a = RegistrationFixture.Attach(EnvironmentPurpose.Runtime)
    try
    {
        await assert.rejects(() => a.client.sendRequest(StorageProtocol.ReadText, { Path: 'a' }), (e: { code?: number }) => e.code === ErrorCodes.MethodNotFound)
        await assert.rejects(() => a.client.sendRequest(StorageProtocol.Delete, { Path: 'a' }), (e: { code?: number }) => e.code === ErrorCodes.MethodNotFound)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

class PushFixture
{
    public readonly Calls: string[] = []
    public readonly Bridge: SourceChangeBridge
    private readonly language: ILanguageService
    private readonly manager = RegistrationFixture.Manager()

    public constructor()
    {
        const signal = { subscribe: () => ({ dispose: () => undefined }) }
        this.language = { GraphChanged: signal, BuildStateChanged: signal, BuildState: GraphBuildState.Ready, DidChange: (uri: string) => { this.Calls.push(uri) } } as unknown as ILanguageService
        this.Bridge = new SourceChangeBridge(this.language)
    }

    public Attach(role: Role | undefined): { handler: ServerConnectionHandler; client: MessageConnection; pushes: unknown[] }
    {
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, this.language, this.manager, RegistrationFixture.Context(role), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, EnvironmentPurpose.Development, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, this.Bridge)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        const pushes: unknown[] = []
        client.onNotification(StorageProtocol.Changed, payload => { pushes.push(payload) })
        client.listen()
        return { handler, client, pushes }
    }

    public static async Settle(): Promise<void>
    {
        await new Promise(resolve => setTimeout(resolve, 50))
    }
}

test('a save on one connection pushes storage/changed to a second connection and drives one DidChange', async () =>
{
    const fx = new PushFixture()
    const a = fx.Attach(Role.Owner)
    const b = fx.Attach(Role.Owner)
    try
    {
        await a.client.sendRequest(StorageProtocol.WriteText, { Path: 'a/x.todl', Content: 'hi' })
        await PushFixture.Settle()
        assert.deepEqual(b.pushes, [{ Kind: 'added', Path: 'a/x.todl', IsDirectory: false }])
        assert.equal(fx.Calls.length, 1)
    }
    finally
    {
        a.client.dispose()
        b.client.dispose()
        a.handler.Dispose()
        b.handler.Dispose()
    }
})

test('a connection whose gate denies reads does not receive the push', async () =>
{
    const fx = new PushFixture()
    const writer = fx.Attach(Role.Owner)
    const reader = fx.Attach(undefined)
    try
    {
        await writer.client.sendRequest(StorageProtocol.WriteText, { Path: 'a/x.todl', Content: 'hi' })
        await PushFixture.Settle()
        assert.equal(writer.pushes.length, 1)
        assert.equal(reader.pushes.length, 0)
    }
    finally
    {
        writer.client.dispose()
        reader.client.dispose()
        writer.handler.Dispose()
        reader.handler.Dispose()
    }
})

test('after a handler is disposed it receives no further pushes', async () =>
{
    const fx = new PushFixture()
    const writer = fx.Attach(Role.Owner)
    const listener = fx.Attach(Role.Owner)
    try
    {
        listener.handler.Dispose()
        await writer.client.sendRequest(StorageProtocol.WriteText, { Path: 'a/x.todl', Content: 'hi' })
        await PushFixture.Settle()
        assert.equal(listener.pushes.length, 0)
        assert.equal(fx.Bridge.Changed.subscriberCount, 1)
    }
    finally
    {
        writer.client.dispose()
        listener.client.dispose()
        writer.handler.Dispose()
    }
})

class CreateFixture
{
    public static readonly Area = 'env/solutions'
    public static readonly Name = 'alpha'
    public static readonly Other = 'beta'
    public static readonly Seeded = 'seed.todl'
    public static readonly SeedText = 'entity X {}'
    public static readonly NestedFile = 'proj/model.todl'
    public static readonly NestedDir = 'proj'
    public static readonly BadNames: readonly unknown[] = ['', '../escape', 'a/b', undefined, 7]

    public readonly Registry = new MemoryStorageRegistry()
    public readonly Roots = new EnvSolutionRoots(CreateFixture.Area, this.Registry)
    public readonly Opened: string[] = []

    public static Manifest(name: string): string
    {
        return `${name}.pksln`
    }

    public Attach(): { handler: ServerConnectionHandler; client: MessageConnection }
    {
        const manager = RegistrationFixture.Manager() as unknown as { OpenSolution: (location: string) => Promise<void> }
        manager.OpenSolution = async location => { this.Opened.push(location) }
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, RegistrationFixture.Language(), manager as unknown as SolutionManagerService, RegistrationFixture.Context(Role.Owner), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, EnvironmentPurpose.Development, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, this.Roots)
        const client = createMessageConnection(new WebSocketMessageReader(clientSocket), new WebSocketMessageWriter(clientSocket), NullLogger)
        client.listen()
        return { handler, client }
    }
}

test('solution/create materializes the root + manifest, activates it, selects it as the authoring target and joins the composed set', async () =>
{
    const fx = new CreateFixture()
    const a = fx.Attach()
    try
    {
        let changes = 0
        fx.Roots.Changed.subscribe(() => { changes++ })
        const result = await a.client.sendRequest(SolutionProtocol.CreateSolution, { Name: CreateFixture.Name })
        assert.deepEqual(result, { Name: CreateFixture.Name, Created: true })
        assert.deepEqual(fx.Opened, [`${CreateFixture.Area}/${CreateFixture.Name}`])
        assert.ok(changes > 0)
        assert.equal(await fx.Roots.RootFor(CreateFixture.Name).Exists(CreateFixture.Manifest(CreateFixture.Name)), true)
        assert.deepEqual(fx.Roots.Names(), [CreateFixture.Name])
        assert.equal(a.handler.Authoring.Selected, CreateFixture.Name)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('solution/create is create-or-replace, last-writer-wins: a re-create clears the root and reports Created=false', async () =>
{
    const fx = new CreateFixture()
    const a = fx.Attach()
    try
    {
        await a.client.sendRequest(SolutionProtocol.CreateSolution, { Name: CreateFixture.Name })
        await fx.Roots.RootFor(CreateFixture.Name).WriteText(CreateFixture.Seeded, CreateFixture.SeedText)
        await fx.Roots.RootFor(CreateFixture.Name).WriteText(CreateFixture.NestedFile, CreateFixture.SeedText)
        const again = await a.client.sendRequest(SolutionProtocol.CreateSolution, { Name: CreateFixture.Name })
        assert.deepEqual(again, { Name: CreateFixture.Name, Created: false })
        const root = fx.Roots.RootFor(CreateFixture.Name)
        assert.equal(await root.Exists(CreateFixture.Seeded), false)
        assert.equal(await root.Exists(CreateFixture.NestedFile), false)
        assert.equal(await root.Exists(CreateFixture.NestedDir), false)
        assert.equal(await root.Exists(CreateFixture.Manifest(CreateFixture.Name)), true)
        await a.client.sendRequest(SolutionProtocol.CreateSolution, { Name: CreateFixture.Other })
        assert.deepEqual([...fx.Roots.Names()].sort(), [CreateFixture.Name, CreateFixture.Other])
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('solution/create rejects a bad or missing name with InvalidParams and keeps the connection alive', async () =>
{
    const fx = new CreateFixture()
    const a = fx.Attach()
    try
    {
        for (const bad of CreateFixture.BadNames)
        {
            await assert.rejects(() => a.client.sendRequest(SolutionProtocol.CreateSolution, { Name: bad as never }), (e: { code?: number }) => e.code === ErrorCodes.InvalidParams)
        }
        assert.deepEqual(await a.client.sendRequest(SolutionProtocol.CreateSolution, { Name: CreateFixture.Name }), { Name: CreateFixture.Name, Created: true })
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})

test('a Runtime environment does not register solution/create', async () =>
{
    const a = RegistrationFixture.Attach(EnvironmentPurpose.Runtime)
    try
    {
        await assert.rejects(() => a.client.sendRequest(SolutionProtocol.CreateSolution, { Name: CreateFixture.Name }), (e: { code?: number }) => e.code !== undefined)
    }
    finally
    {
        a.client.dispose()
        a.handler.Dispose()
    }
})
