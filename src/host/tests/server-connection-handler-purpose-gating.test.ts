import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/pragmatic-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'

class Fixtures
{
    public static readonly Uri = 'file:///a.todl'
    public static readonly Location = 'does-not-exist'
    public static readonly Member = 'no-such-member'

    public static OwnerContext(): AccessContext
    {
        const realm = new Realm('t1', RealmKind.SelfHosted, 'Environment One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Realm, 't1', []))]
        return new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy())
    }
}

class Harness
{
    public readonly Client: PragmaticClient
    private readonly server: PragmaticServer
    private readonly handler: ServerConnectionHandler

    private constructor(server: PragmaticServer, handler: ServerConnectionHandler, client: PragmaticClient)
    {
        this.server = server
        this.handler = handler
        this.Client = client
    }

    public static async Create(purpose: EnvironmentPurpose): Promise<Harness>
    {
        const server = new PragmaticServer({ packagesRoot: mkdtempSync(join(tmpdir(), 'ps-pkgs-purpose-')) })
        await server.Start()
        const service = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, service, manager, Fixtures.OwnerContext(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, purpose)
        return new Harness(server, handler, PragmaticClient.CreateOverSocket(clientSocket))
    }

    /** Code of the JSON-RPC error the call rejects with, or undefined if it resolves. */
    public static async ErrorCodeOf(call: () => Promise<unknown>): Promise<number | undefined>
    {
        try
        {
            await call()
            return undefined
        }
        catch (error)
        {
            return (error as { code?: number }).code
        }
    }

    public async Close(): Promise<void>
    {
        await this.Client.DisposeAsync()
        this.handler.Dispose()
        await (await this.server.Manager()).CloseSolution()
        await this.server.Dispose()
    }
}

test('a runtime environment rejects Language requests as method-not-found', async () =>
{
    const harness = await Harness.Create(EnvironmentPurpose.Runtime)
    try
    {
        assert.equal(await Harness.ErrorCodeOf(() => harness.Client.DocumentSymbols(Fixtures.Uri)), ErrorCodes.MethodNotFound)
    }
    finally
    {
        await harness.Close()
    }
})

test('a runtime environment rejects Solution requests as method-not-found', async () =>
{
    const harness = await Harness.Create(EnvironmentPurpose.Runtime)
    try
    {
        assert.equal(await Harness.ErrorCodeOf(() => harness.Client.OpenSolution(Fixtures.Location)), ErrorCodes.MethodNotFound)
        assert.equal(await Harness.ErrorCodeOf(() => harness.Client.ActiveSolution()), ErrorCodes.MethodNotFound)
    }
    finally
    {
        await harness.Close()
    }
})

test('a development environment still registers Language and Solution requests', async () =>
{
    const harness = await Harness.Create(EnvironmentPurpose.Development)
    try
    {
        assert.notEqual(await Harness.ErrorCodeOf(() => harness.Client.DocumentSymbols(Fixtures.Uri)), ErrorCodes.MethodNotFound)
        assert.notEqual(await Harness.ErrorCodeOf(() => harness.Client.OpenSolution(Fixtures.Location)), ErrorCodes.MethodNotFound)
        assert.notEqual(await Harness.ErrorCodeOf(() => harness.Client.ActiveSolution()), ErrorCodes.MethodNotFound)
    }
    finally
    {
        await harness.Close()
    }
})

test('a runtime environment still registers non-gated requests', async () =>
{
    const harness = await Harness.Create(EnvironmentPurpose.Runtime)
    try
    {
        assert.notEqual(await Harness.ErrorCodeOf(() => harness.Client.ModelView(Fixtures.Member)), ErrorCodes.MethodNotFound)
    }
    finally
    {
        await harness.Close()
    }
})
