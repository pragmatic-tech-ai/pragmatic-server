import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ConnectionFailureKind, DataSourceKind, ReconnectingAdapter, WriteAtomicity, WriteConcurrency } from '@pragmatic-tech-ai/todl'
import type { DataSourceAdapterCatalog, ExternalRecord, IDataSourceAdapter, IDataSourceAdapterFactory, IDataSourceContext, QueryRequest, ResolvedConnection, WriteBatch, WriteResult } from '@pragmatic-tech-ai/todl'
import { SqlAdapterFactory } from '@pragmatic-tech-ai/todl-connectors-host'
import type { PgPoolOptions } from '@pragmatic-tech-ai/todl-connectors-host'
import type { Pool } from 'pg'
import { PresentedSecret, SourceToken, SourceTokenError, SourceTokenFailure, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecretStore, ISourceTokenProvider, SourceTokenRequest } from '@pragmatic-tech-ai/todl-identity'
import { UpstreamTokens, UpstreamTokenVault } from '@pragmatic-tech-ai/todl-identity-cloud'
import { ServiceProvider, Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { CallerCredentialAdapterFactory, CallerCredentialError, CallerCredentialErrorCode, ConnectionCredentialMode } from '../caller-credential-adapter-factory.js'
import { CallerCredentials } from '../caller-credentials.js'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'

/** An inner adapter that answers every read with the secret it was opened with; `AuthFails` makes reads fail as Auth. */
class TokenEchoAdapter implements IDataSourceAdapter
{
    public static readonly TokenField = 'token'
    private static readonly RejectedMessage = 'the source rejected the token'

    public Disposed = false
    public AuthFails = false
    public Applied = 0
    public readonly CanPage = true
    /** An etag-style source when set (the factory's `ManagesVersions`). */
    public SourceManagesVersions = false
    /** While set, reads wait on it (a call held in flight). */
    public Gate: Promise<void> | undefined
    public readonly Contexts: (string | undefined)[] = []

    public constructor(public readonly Secret: string | undefined)
    {
    }

    public async Query(_request: QueryRequest, context?: IDataSourceContext): Promise<readonly ExternalRecord[]>
    {
        this.Contexts.push(context?.Key)
        // a turn of the event loop, so concurrent callers interleave
        await new Promise(resolve => setImmediate(resolve))
        await this.Gate
        if (this.AuthFails) throw new Error(TokenEchoAdapter.RejectedMessage)
        return [{ [TokenEchoAdapter.TokenField]: this.Secret ?? null }]
    }

    public async Apply(): Promise<WriteResult>
    {
        this.Applied++
        return { Applied: 0, Failures: [] }
    }

    public ClassifyFailure(): ConnectionFailureKind
    {
        return ConnectionFailureKind.Auth
    }

    public async Dispose(): Promise<void>
    {
        this.Disposed = true
    }
}

class EchoFactory implements IDataSourceAdapterFactory
{
    public readonly Kind = DataSourceKind.Sql
    public readonly Opened: TokenEchoAdapter[] = []
    public ManagesVersions = false

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        const adapter = new TokenEchoAdapter(connection.Secret)
        adapter.SourceManagesVersions = this.ManagesVersions
        this.Opened.push(adapter)
        return adapter
    }

    /** The adapters opened with a secret (the probe is opened with none). */
    public get Connected(): TokenEchoAdapter[]
    {
        return this.Opened.filter(adapter => adapter.Secret !== undefined)
    }
}

/** A pg pool stand-in for SqlAdapterFactory: records whether anything connected or queried, and whether it ended. */
class RecordingPool
{
    public static readonly Built: RecordingPool[] = []

    public Connects = 0
    public Queries = 0
    public Ended = false

    public constructor(public readonly Options: PgPoolOptions)
    {
        RecordingPool.Built.push(this)
    }

    public static Builder(): (options: PgPoolOptions) => Pool
    {
        return options => new RecordingPool(options) as unknown as Pool
    }

    public async connect(): Promise<never>
    {
        this.Connects++
        throw new Error(RecordingPool.NotConnectable)
    }

    public async query(): Promise<{ rows: unknown[] }>
    {
        this.Queries++
        return { rows: [] }
    }

    public async end(): Promise<void>
    {
        this.Ended = true
    }

    private static readonly NotConnectable = 'the recording pool never connects'
}

class FakeTokens implements ISourceTokenProvider
{
    private static readonly TokenPrefix = 'token-of-'
    private static readonly LifetimeMs = 3600000

    private static readonly RenewedSuffix = '-renewed'

    public readonly Requests: SourceTokenRequest[] = []
    public readonly Failing = new Set<string>()
    /** Principals whose next tokens are renewed ones. */
    public readonly Renewed = new Set<string>()

    public static RenewedTokenOf(principalId: string): string
    {
        return FakeTokens.TokenOf(principalId) + FakeTokens.RenewedSuffix
    }

    public static TokenOf(principalId: string): string
    {
        return FakeTokens.TokenPrefix + principalId
    }

    public async Acquire(request: SourceTokenRequest): Promise<SourceToken>
    {
        this.Requests.push(request)
        await new Promise(resolve => setImmediate(resolve))
        if (this.Failing.has(request.PrincipalId)) throw new SourceTokenError(SourceTokenFailure.NoUpstreamSession)
        const value = this.Renewed.has(request.PrincipalId) ? FakeTokens.RenewedTokenOf(request.PrincipalId) : FakeTokens.TokenOf(request.PrincipalId)
        return new SourceToken(request.Resource, new PresentedSecret(value), new Date(Date.now() + FakeTokens.LifetimeMs))
    }
}

class MemorySecrets implements ISecretStore
{
    private readonly secrets = new Map<string, string>()

    public async Get(reference: string): Promise<string | null>
    {
        return this.secrets.get(reference) ?? null
    }

    public async Put(reference: string, secret: string): Promise<void>
    {
        this.secrets.set(reference, secret)
    }

    public async Delete(reference: string): Promise<void>
    {
        this.secrets.delete(reference)
    }
}

class IdsSignal implements ISignal<readonly string[]>
{
    private readonly signal = new Signal<readonly string[]>()

    public Subscribe(handler: (value: readonly string[]) => void): ISubscription
    {
        return this.signal.subscribe(handler)
    }

    public Raise(ids: readonly string[]): void
    {
        this.signal.emit(ids)
    }
}

class CallerFx
{
    public static readonly Alice = 'alice'
    public static readonly Bob = 'bob'
    public static readonly Resource = 'api://crm'
    public static readonly AppSecret = 'app-secret'
    public static readonly Source = 'Account'
    public static readonly Tenant = new Tenant('env-1', TenantKind.SelfHosted, 'Environment One')
    public static readonly Request: QueryRequest = { Source: CallerFx.Source, Fields: [TokenEchoAdapter.TokenField] }
    public static readonly UpstreamAccess = 'upstream-access'
    public static readonly UpstreamRefresh = 'upstream-refresh'
    public static readonly UnknownModes = ['Caller', 'user']
    public static readonly Rejected = 'rejected'
    public static readonly Fulfilled = 'fulfilled'
    private static readonly MaxTicks = 20

    public static readonly Database = 'crm'
    public static readonly VersionField = 'etag'

    /** A caller's-identity SQL connection (what the built-in SqlAdapterFactory opens). */
    public static SqlConnection(): ResolvedConnection
    {
        const connection = CallerFx.Connection(ConnectionCredentialMode.Caller)
        return { ...connection, Config: { ...connection.Config, [CallerFx.DatabaseKey]: CallerFx.Database } }
    }

    private static readonly IdKey = 'id'
    public static readonly Batch: WriteBatch = { Source: CallerFx.Source, IdKey: CallerFx.IdKey, Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Transactional, VersionField: CallerFx.VersionField, Operations: [] }
    private static readonly DatabaseKey = 'database'

    public static Connection(mode: ConnectionCredentialMode | string | undefined): ResolvedConnection
    {
        const config: Record<string, string> = { [CallerCredentialAdapterFactory.TokenResourceKey]: CallerFx.Resource }
        if (mode !== undefined) config[CallerCredentialAdapterFactory.CredentialsKey] = mode
        return { Kind: DataSourceKind.Sql, Config: config, Secret: CallerFx.AppSecret }
    }

    public static Context(key: string): IDataSourceContext
    {
        return { Key: key }
    }

    public static async Read(adapter: IDataSourceAdapter, principalId: string): Promise<unknown>
    {
        return (await adapter.Query(CallerFx.Request, CallerFx.Context(principalId)))[0]![TokenEchoAdapter.TokenField]
    }

    /** Lets fire-and-forget work settle until `done` holds (bounded). */
    public static async Until(done: () => Promise<boolean>): Promise<void>
    {
        for (let tick = 0; tick < CallerFx.MaxTicks && !(await done()); tick++) await new Promise(resolve => setImmediate(resolve))
    }
}

describe('caller credential adapter factory', () =>
{
    test('caller\'s-identity connection reads with each caller\'s token', async () =>
    {
        const inner = new EchoFactory()
        const tokens = new FakeTokens()
        const adapter = await new CallerCredentialAdapterFactory(inner, tokens, CallerFx.Tenant).Open(CallerFx.Connection(ConnectionCredentialMode.Caller))
        assert.equal(adapter.CanPage, false, 'before any caller: the weakest guarantee')
        const [alice, bob] = await Promise.all([CallerFx.Read(adapter, CallerFx.Alice), CallerFx.Read(adapter, CallerFx.Bob)])
        assert.equal(alice, FakeTokens.TokenOf(CallerFx.Alice))
        assert.equal(bob, FakeTokens.TokenOf(CallerFx.Bob))
        assert.deepEqual(tokens.Requests.map(request => [request.TenantId, request.PrincipalId, request.Resource]).sort(),
            [[CallerFx.Tenant.Id, CallerFx.Alice, CallerFx.Resource], [CallerFx.Tenant.Id, CallerFx.Bob, CallerFx.Resource]])
        assert.equal(inner.Connected.length, 2, 'one inner adapter per principal')
        for (const opened of inner.Connected) assert.deepEqual(opened.Contexts, [opened.Secret === FakeTokens.TokenOf(CallerFx.Alice) ? CallerFx.Alice : CallerFx.Bob], 'each inner adapter serves only its own principal')
        assert.ok(inner.Opened.every(opened => opened.Secret !== CallerFx.AppSecret && opened.Secret !== undefined), 'never opened with the app credentials, nor without a caller\'s token')
        assert.equal(adapter.CanPage, true, 'the flags are latched from the first principal\'s inner adapter')
    })

    test('a built-in factory reports its capabilities before any call, without connecting (R36)', async () =>
    {
        RecordingPool.Built.length = 0
        const adapter = await new CallerCredentialAdapterFactory(new SqlAdapterFactory(RecordingPool.Builder()), new FakeTokens(), CallerFx.Tenant).Open(CallerFx.SqlConnection())
        // what TODL's DataSourceTransaction.Apply reads before a transactional write's first adapter call
        assert.equal(adapter.CanTransact, true, 'a transactional write as the very first call is not refused')
        assert.equal(adapter.CanPage, true)
        const probe = RecordingPool.Built[0]!
        assert.equal(RecordingPool.Built.length, 1)
        assert.equal(probe.Options.password, undefined, 'the probe carries no secret (no app credentials)')
        assert.deepEqual([probe.Connects, probe.Queries, probe.Ended], [0, 0, true], 'the probe never connected or queried, and was ended')
        await adapter.Query(CallerFx.Request, CallerFx.Context(CallerFx.Alice))
        const alices = RecordingPool.Built[1]!
        assert.equal(alices.Options.password, FakeTokens.TokenOf(CallerFx.Alice), 'the read runs on a pool opened with alice\'s token')
        assert.equal(alices.Queries, 1)
        assert.equal(probe.Queries, 0)
    })

    test('a write that first learns the source manages versions is refused, never sent bumped (R36)', async () =>
    {
        const inner = new EchoFactory()
        inner.ManagesVersions = true
        const adapter = await new CallerCredentialAdapterFactory(inner, new FakeTokens(), CallerFx.Tenant).Open(CallerFx.Connection(ConnectionCredentialMode.Caller))
        assert.equal(adapter.CanTransact, false, 'an unknown factory: TODL refuses a transactional write explicitly until a caller opened it')
        await assert.rejects(adapter.Apply(CallerFx.Batch, CallerFx.Context(CallerFx.Alice)), (error: unknown) => error instanceof CallerCredentialError && error.Code === CallerCredentialErrorCode.CapabilitiesUnsettled)
        assert.equal(inner.Connected[0]!.Applied, 0, 'nothing reached the source')
        assert.equal(adapter.SourceManagesVersions, true, 'latched now')
        await adapter.Apply(CallerFx.Batch, CallerFx.Context(CallerFx.Alice))
        assert.equal(inner.Connected[0]!.Applied, 1, 'the next write goes through')
    })

    test('an unknown credential mode is refused, never read as dedicated', async () =>
    {
        const inner = new EchoFactory()
        const factory = new CallerCredentialAdapterFactory(inner, new FakeTokens(), CallerFx.Tenant)
        for (const mode of CallerFx.UnknownModes)
        {
            await assert.rejects(factory.Open(CallerFx.Connection(mode)), (error: unknown) => error instanceof CallerCredentialError && error.Code === CallerCredentialErrorCode.UnknownCredentialMode)
        }
        assert.equal(inner.Opened.length, 0, 'nothing opened with the app credentials')
    })

    test('a renewed token reopens the principal\'s adapter without cutting off its in-flight call', async () =>
    {
        const inner = new EchoFactory()
        const tokens = new FakeTokens()
        const adapter = await new CallerCredentialAdapterFactory(inner, tokens, CallerFx.Tenant).Open(CallerFx.Connection(ConnectionCredentialMode.Caller))
        await CallerFx.Read(adapter, CallerFx.Alice)
        const first = inner.Connected[0]!
        let release: () => void = () => undefined
        first.Gate = new Promise<void>(resolve => { release = resolve })
        const inFlight = CallerFx.Read(adapter, CallerFx.Alice)
        await CallerFx.Until(async () => first.Contexts.length === 2)
        tokens.Renewed.add(CallerFx.Alice)
        assert.equal(await CallerFx.Read(adapter, CallerFx.Alice), FakeTokens.RenewedTokenOf(CallerFx.Alice), 'the renewed token opens a fresh adapter')
        assert.equal(first.Disposed, false, 'the old adapter drains its in-flight call first')
        release()
        assert.equal(await inFlight, FakeTokens.TokenOf(CallerFx.Alice), 'the in-flight call finishes on the old adapter')
        assert.equal(first.Disposed, true, 'then the old adapter is disposed')
    })

    test('anonymous context is refused by a caller\'s-identity connection', async () =>
    {
        const inner = new EchoFactory()
        const tokens = new FakeTokens()
        const adapter = await new CallerCredentialAdapterFactory(inner, tokens, CallerFx.Tenant).Open(CallerFx.Connection(ConnectionCredentialMode.Caller))
        await assert.rejects(adapter.Query(CallerFx.Request), CallerCredentialError)
        await assert.rejects(adapter.Query(CallerFx.Request, CallerFx.Context('')), CallerCredentialError)
        assert.equal(tokens.Requests.length, 0)
        assert.equal(inner.Connected.length, 0)
    })

    test('a failed token acquisition never falls back', async () =>
    {
        const inner = new EchoFactory()
        const tokens = new FakeTokens()
        tokens.Failing.add(CallerFx.Alice)
        const adapter = await new CallerCredentialAdapterFactory(inner, tokens, CallerFx.Tenant).Open(CallerFx.Connection(ConnectionCredentialMode.Caller))
        await assert.rejects(adapter.Query(CallerFx.Request, CallerFx.Context(CallerFx.Alice)), (error: unknown) =>
            error instanceof SourceTokenError && !error.message.includes(FakeTokens.TokenOf(CallerFx.Alice)))
        assert.equal(inner.Connected.length, 0, 'no adapter opened: neither with the app credentials nor without a token')
    })

    test('a per-user token failure does not reopen the shared adapter for other callers (R28)', async () =>
    {
        const inner = new EchoFactory()
        const tokens = new FakeTokens()
        const factory = new CallerCredentialAdapterFactory(inner, tokens, CallerFx.Tenant)
        const connection = CallerFx.Connection(ConnectionCredentialMode.Caller)
        let reopened = 0
        const caller = await factory.Open(connection)
        // TODL's retrying wrapper, as the adapter catalog builds it: one shared adapter per connector
        const shared = new ReconnectingAdapter(CallerFx.Source, caller, async () =>
        {
            reopened++
            return factory.Open(connection)
        }, { InitialDelayMs: 0, Factor: 1, MaxDelayMs: 0, MaxAttempts: 3 }, undefined, () => 0, async () => undefined)
        assert.equal(await CallerFx.Read(shared, CallerFx.Bob), FakeTokens.TokenOf(CallerFx.Bob))
        const bobs = inner.Connected[0]!
        tokens.Failing.add(CallerFx.Alice)
        const [failed, bob] = await Promise.allSettled([CallerFx.Read(shared, CallerFx.Alice), CallerFx.Read(shared, CallerFx.Bob)])
        assert.equal(failed.status, CallerFx.Rejected)
        assert.equal(caller.ClassifyFailure!((failed as PromiseRejectedResult).reason), ConnectionFailureKind.Permanent, 'a token failure is never Auth')
        assert.deepEqual(bob, { status: CallerFx.Fulfilled, value: FakeTokens.TokenOf(CallerFx.Bob) })
        // the source refusing alice's token (an inner Auth failure) drops only alice's inner adapter
        tokens.Failing.delete(CallerFx.Alice)
        assert.equal(await CallerFx.Read(shared, CallerFx.Alice), FakeTokens.TokenOf(CallerFx.Alice))
        const alices = inner.Connected.find(opened => opened.Secret === FakeTokens.TokenOf(CallerFx.Alice))!
        alices.AuthFails = true
        await assert.rejects(CallerFx.Read(shared, CallerFx.Alice))
        assert.equal(alices.Disposed, true, 'alice reconnects on her next call')
        assert.equal(await CallerFx.Read(shared, CallerFx.Bob), FakeTokens.TokenOf(CallerFx.Bob))
        assert.equal(reopened, 0, 'the shared adapter was never reopened')
        assert.equal(bobs.Disposed, false, 'bob\'s connection was never touched')
    })

    test('dedicated-credential connection ignores the context', async () =>
    {
        const inner = new EchoFactory()
        const tokens = new FakeTokens()
        const factory = new CallerCredentialAdapterFactory(inner, tokens, CallerFx.Tenant)
        for (const mode of [undefined, ConnectionCredentialMode.Dedicated])
        {
            const adapter = await factory.Open(CallerFx.Connection(mode))
            assert.equal(adapter, inner.Opened[inner.Opened.length - 1], 'the inner adapter unchanged')
            assert.equal(await CallerFx.Read(adapter, CallerFx.Alice), CallerFx.AppSecret)
        }
        assert.equal(tokens.Requests.length, 0)
    })

    test('a deprovisioned principal\'s stored and cached tokens are revoked (R27)', async () =>
    {
        const inner = new EchoFactory()
        const tokens = new FakeTokens()
        const vault = new UpstreamTokenVault(new MemorySecrets())
        await vault.Put(CallerFx.Tenant.Id, CallerFx.Alice, new UpstreamTokens(CallerFx.UpstreamAccess, CallerFx.UpstreamRefresh))
        const credentials = new CallerCredentials()
        credentials.Bind(tokens, CallerFx.Tenant, vault)
        const adapter = await credentials.Wrap(inner).Open(CallerFx.Connection(ConnectionCredentialMode.Caller))
        await CallerFx.Read(adapter, CallerFx.Alice)
        await CallerFx.Read(adapter, CallerFx.Alice)
        assert.equal(tokens.Requests.length, 1, 'the second call used the cached token')
        const deprovisioned = new IdsSignal()
        const subscription = credentials.Follow(deprovisioned)
        try
        {
            deprovisioned.Raise([CallerFx.Alice])
            await CallerFx.Until(async () => (await vault.Get(CallerFx.Tenant.Id, CallerFx.Alice)) === null)
            assert.equal(await vault.Get(CallerFx.Tenant.Id, CallerFx.Alice), null, 'the stored upstream tokens are deleted')
            assert.equal(inner.Connected[0]!.Disposed, true, 'the principal\'s inner connection is closed')
            assert.equal(await CallerFx.Read(adapter, CallerFx.Alice), FakeTokens.TokenOf(CallerFx.Alice))
            assert.equal(tokens.Requests.length, 2, 'the next call re-acquires')
        }
        finally
        {
            subscription.dispose()
        }
    })
})

class RegistrationFx
{
    public static readonly NoAdapter = 'no data-source adapter available'
}

/** Reaches the server's process-wide adapter catalog (protected on PragmaticServer). */
class CatalogServer extends PragmaticServer
{
    public Catalog(): DataSourceAdapterCatalog
    {
        return this.AdapterCatalog()
    }
}

describe('caller credentials registration', () =>
{
    test('every adapter kind the server registers is wrapped in the caller\'s credentials', async () =>
    {
        const server = new CatalogServer({ purpose: TenantPurpose.Runtime })
        try
        {
            const catalog = server.Catalog()
            for (const kind of Object.values(DataSourceKind))
            {
                const spec = { Name: kind, Kind: kind, Config: { [CallerCredentialAdapterFactory.CredentialsKey]: ConnectionCredentialMode.Caller } }
                // a wrapped factory refuses a caller connection naming no token resource before the inner factory runs;
                // a kind with no factory at all fails to resolve; an unwrapped one would open with app credentials
                await assert.rejects(catalog.Open(spec, new ServiceProvider()), (error: unknown) =>
                    (error instanceof CallerCredentialError && error.Code === CallerCredentialErrorCode.NoTokenResource)
                    || (error instanceof Error && error.message.includes(RegistrationFx.NoAdapter)), kind)
            }
        }
        finally
        {
            await server.Dispose()
        }
    })
})
