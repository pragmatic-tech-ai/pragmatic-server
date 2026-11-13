import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, ResponseError, ErrorCodes, DataSourceUnavailableError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import type { IGraphConnectorService } from '../engine/engine-connector-service.js'
import type { RequestInstrumentation } from '../../observability/request-instrumentation.js'
import { ConnectorError, ConnectorPhase } from '@pragmatic-tech-ai/graph'
import type { IDispatchDiagnostics } from '../dispatch-diagnostics.js'
import { LoggerDispatchDiagnostics } from '../dispatch-diagnostics.js'
import { DataSourceFailure } from '../engine/data-source-failure.js'
import { StructuredLogger } from '../../observability/logger.js'

/** Connector endpoints whose every call rejects with `thrown` (the dispatch path under test sees the raw error). */
class FailingConnectors implements IGraphConnectorService
{
    public constructor(private readonly thrown: unknown)
    {
    }

    public List(): Promise<never>
    {
        return this.Fail()
    }

    public Prepare(): Promise<never>
    {
        return this.Fail()
    }

    public Refresh(): Promise<never>
    {
        return this.Fail()
    }

    public RefreshModel(): Promise<never>
    {
        return this.Fail()
    }

    public Read(): Promise<never>
    {
        return this.Fail()
    }

    public ReadPage(): Promise<never>
    {
        return this.Fail()
    }

    public WritePaged(): Promise<never>
    {
        return this.Fail()
    }

    public WriteBack(): Promise<never>
    {
        return this.Fail()
    }

    public Decisions(): Promise<never>
    {
        return this.Fail()
    }

    public Test(): Promise<never>
    {
        return this.Fail()
    }

    private Fail(): Promise<never>
    {
        return Promise.reject(this.thrown)
    }
}

/** Dispatch diagnostics that keep what they were told, per kind. */
class RecordedDiagnostics implements IDispatchDiagnostics
{
    public readonly Unexpecteds: { method: string, error: unknown }[] = []
    public readonly DataSources: { method: string, error: unknown }[] = []

    public Unexpected(method: string, error: unknown): void
    {
        this.Unexpecteds.push({ method, error })
    }

    public DataSourceFailed(method: string, error: unknown): void
    {
        this.DataSources.push({ method, error })
    }
}

class Fixtures
{
    public static readonly Secret = 'secret internal detail'
    public static readonly NoActiveSolution = 'no active solution after open'
    public static readonly SyncSecret = 'secret sync detail'
    public static readonly DataSource = 'catalog@connector:Catalog'
    public static readonly DataSourceName = 'catalog.Catalog'

    public static OwnerContext(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    /** Requests a model view while no solution is open, returning the client-facing failure. */
    public static async NoSolutionFailure(): Promise<{ code?: number, message?: string }>
    {
        const packages = mkdtempSync(join(tmpdir(), 'ps-pkgs-'))
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const development = ServerConnectionHandler.DevelopmentAttachArgs(server)
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, Fixtures.OwnerContext(), undefined, development.cypherQuery, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, development.devGraphService, undefined, development.modelView)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        try
        {
            let captured: unknown
            try
            {
                await client.ModelView('missing/member')
            }
            catch (error)
            {
                captured = error
            }
            assert.ok(captured !== undefined, 'expected the request to reject')
            return captured as { code?: number, message?: string }
        }
        finally
        {
            await client.DisposeAsync()
            handler.Dispose()
            await (languageService as SolutionLanguageService).WhenIdle()
            await manager.CloseSolution()
            await server.Dispose()
        }
    }

    /** Drives Connectors() through the real dispatch path with connector endpoints that reject with the given error. */
    public static async Failure(thrown: unknown, instrumentation?: RequestInstrumentation, diagnostics: IDispatchDiagnostics = new RecordedDiagnostics()): Promise<{ code?: number, message?: string, data?: unknown, serialized: string }>
    {
        const packages = mkdtempSync(join(tmpdir(), 'ps-pkgs-'))
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, Fixtures.OwnerContext(), new FailingConnectors(thrown), undefined, instrumentation, /* parent */ undefined, /* audit */ undefined, /* rateLimit */ undefined, /* admin */ undefined, /* cypherLimits */ undefined, /* purpose */ undefined, /* applications */ undefined, /* data */ undefined, /* paging */ undefined, /* cypherExecute */ undefined, /* deployProvider */ undefined, /* devGraphService */ undefined, /* environmentGraphHost */ undefined, /* modelView */ undefined, /* dataChanges */ undefined, diagnostics)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        try
        {
            let captured: unknown
            try
            {
                await client.Connectors()
            }
            catch (error)
            {
                captured = error
            }
            assert.ok(captured !== undefined, 'expected the request to reject')
            const failure = captured as { code?: number, message?: string, data?: unknown }
            return { code: failure.code, message: failure.message, data: failure.data, serialized: JSON.stringify(captured, Object.getOwnPropertyNames(captured as object)) }
        }
        finally
        {
            await client.DisposeAsync()
            handler.Dispose()
            await (languageService as SolutionLanguageService).WhenIdle()
            await manager.CloseSolution()
            await server.Dispose()
        }
    }
}

test('a raw thrown Error is scrubbed to a generic InternalError and never leaks its message', async () =>
{
    const failure = await Fixtures.Failure(new Error(Fixtures.Secret))
    assert.equal(failure.code, ErrorCodes.InternalError)
    assert.ok(!(failure.message ?? '').includes(Fixtures.Secret))
    assert.ok(!failure.serialized.includes(Fixtures.Secret))
})

test('an unexpected error is reported to the dispatch diagnostics with its method, while the wire stays generic', async () =>
{
    const diagnostics = new RecordedDiagnostics()
    const thrown = new Error(Fixtures.Secret)
    const failure = await Fixtures.Failure(thrown, undefined, diagnostics)
    assert.equal(failure.code, ErrorCodes.InternalError)
    assert.equal(diagnostics.Unexpecteds.length, 1)
    assert.equal(diagnostics.Unexpecteds[0]!.error, thrown)
    assert.ok(diagnostics.Unexpecteds[0]!.method.startsWith('connector/'))
    assert.equal(diagnostics.DataSources.length, 0)
})

test('a typed failure the client is told about is not reported as unexpected', async () =>
{
    const diagnostics = new RecordedDiagnostics()
    await Fixtures.Failure(new ResponseError(ErrorCodes.InvalidParams, 'bad field X'), undefined, diagnostics)
    assert.equal(diagnostics.Unexpecteds.length, 0)
})

test('a data source that fails to fetch reaches the client typed, naming the source but never the cause', async () =>
{
    const diagnostics = new RecordedDiagnostics()
    const thrown = new ConnectorError(Fixtures.DataSource, ConnectorPhase.Fetch, new Error(Fixtures.Secret))
    const failure = await Fixtures.Failure(thrown, undefined, diagnostics)
    assert.equal(failure.code, DataSourceUnavailableError.Code)
    assert.equal(failure.message, DataSourceUnavailableError.MessageStart + Fixtures.DataSourceName)
    assert.equal(DataSourceUnavailableError.DataSourceOf(failure), Fixtures.DataSourceName)
    assert.deepEqual(failure.data, { dataSource: Fixtures.DataSourceName })
    assert.ok(!failure.serialized.includes(Fixtures.Secret))
    assert.equal(diagnostics.DataSources.length, 1)
    assert.equal(diagnostics.DataSources[0]!.error, thrown)
    assert.equal(diagnostics.Unexpecteds.length, 0)
})

test('a connector failure outside a fetch stays a generic internal error', async () =>
{
    const failure = await Fixtures.Failure(new ConnectorError(Fixtures.DataSource, ConnectorPhase.Commit, new Error(Fixtures.Secret)))
    assert.equal(failure.code, ErrorCodes.InternalError)
    assert.ok(!failure.serialized.includes(Fixtures.DataSource))
})

test('a data source name that is not a connector node id is reported as is', () =>
{
    assert.equal(DataSourceFailure.NameOf('plain'), 'plain')
    assert.equal(DataSourceFailure.NameOf('@connector:x'), '@connector:x')
})

test('the logger diagnostics write the method and the error with its cause to the server log', () =>
{
    const lines: string[] = []
    const diagnostics = new LoggerDispatchDiagnostics(StructuredLogger.ToSink(line => lines.push(line)))
    diagnostics.DataSourceFailed('cypher/query', new ConnectorError(Fixtures.DataSource, ConnectorPhase.Fetch, new Error(Fixtures.Secret)))
    diagnostics.Unexpected('cypher/query', new Error(Fixtures.SyncSecret))
    const [warn, error] = lines.map(line => JSON.parse(line) as { level: string, method: string, error: { message: string, cause?: { message: string } } })
    assert.equal(warn!.level, 'warn')
    assert.equal(warn!.method, 'cypher/query')
    assert.equal(warn!.error.cause?.message, Fixtures.Secret)
    assert.equal(error!.level, 'error')
    assert.equal(error!.error.message, Fixtures.SyncSecret)
})

test('a ResponseError(InvalidParams) reaches the client unchanged', async () =>
{
    const failure = await Fixtures.Failure(new ResponseError(ErrorCodes.InvalidParams, 'bad field X'))
    assert.equal(failure.code, ErrorCodes.InvalidParams)
    assert.ok((failure.message ?? '').includes('bad field X'))
})

test('a ResponseError with a non-standard code passes through with its data', async () =>
{
    const failure = await Fixtures.Failure(new ResponseError(ServerConnectionHandler.RateLimitedCode, 'slow down', { retryAfterMs: 5 }))
    assert.equal(failure.code, ServerConnectionHandler.RateLimitedCode)
    assert.ok((failure.message ?? '').includes('slow down'))
    assert.deepEqual(failure.data, { retryAfterMs: 5 })
})

test('a synchronous throw on the dispatch path is scrubbed too', async () =>
{
    const throwing = { Run: (): never => { throw new Error(Fixtures.SyncSecret) } } as unknown as RequestInstrumentation
    const failure = await Fixtures.Failure(new Error('unused'), throwing)
    assert.equal(failure.code, ErrorCodes.InternalError)
    assert.ok(!(failure.message ?? '').includes(Fixtures.SyncSecret))
    assert.ok(!failure.serialized.includes(Fixtures.SyncSecret))
    assert.ok((failure.message ?? '').includes('internal error'))
})

test('the no-active-solution condition reaches the client as an actionable InvalidRequest, not the generic scrub', async () =>
{
    const failure = await Fixtures.NoSolutionFailure()
    assert.equal(failure.code, ErrorCodes.InvalidRequest)
    assert.ok((failure.message ?? '').includes(Fixtures.NoActiveSolution))
    assert.ok(!(failure.message ?? '').includes('internal error'))
})
