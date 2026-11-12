import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ConnectionFailureKind, DataSourceKind, ReconnectingAdapter } from '@pragmatic-tech-ai/todl'
import type { ExternalRecord, IDataSourceAdapter, IDataSourceAdapterFactory, IDataSourceContext, QueryRequest, ResolvedConnection, WriteResult } from '@pragmatic-tech-ai/todl'
import { PresentedSecret, SourceToken, SourceTokenError, SourceTokenFailure, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecretStore, ISourceTokenProvider, SourceTokenRequest } from '@pragmatic-tech-ai/todl-identity'
import { UpstreamTokens, UpstreamTokenVault } from '@pragmatic-tech-ai/todl-identity-cloud'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { CallerCredentialAdapterFactory, CallerCredentialError, ConnectionCredentialMode } from '../caller-credential-adapter-factory.js'
import { CallerCredentials } from '../caller-credentials.js'

/** An inner adapter that answers every read with the secret it was opened with; `AuthFails` makes reads fail as Auth. */
class TokenEchoAdapter implements IDataSourceAdapter
{
    public static readonly TokenField = 'token'
    private static readonly RejectedMessage = 'the source rejected the token'

    public Disposed = false
    public AuthFails = false
    public readonly Contexts: (string | undefined)[] = []

    public constructor(public readonly Secret: string | undefined)
    {
    }

    public async Query(_request: QueryRequest, context?: IDataSourceContext): Promise<readonly ExternalRecord[]>
    {
        this.Contexts.push(context?.Key)
        // a turn of the event loop, so concurrent callers interleave
        await new Promise(resolve => setImmediate(resolve))
        if (this.AuthFails) throw new Error(TokenEchoAdapter.RejectedMessage)
        return [{ [TokenEchoAdapter.TokenField]: this.Secret ?? null }]
    }

    public async Apply(): Promise<WriteResult>
    {
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

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        const adapter = new TokenEchoAdapter(connection.Secret)
        this.Opened.push(adapter)
        return adapter
    }

    /** The adapters opened with a secret (the probe is opened with none). */
    public get Connected(): TokenEchoAdapter[]
    {
        return this.Opened.filter(adapter => adapter.Secret !== undefined)
    }
}

class FakeTokens implements ISourceTokenProvider
{
    private static readonly TokenPrefix = 'token-of-'
    private static readonly LifetimeMs = 3600000

    public readonly Requests: SourceTokenRequest[] = []
    public readonly Failing = new Set<string>()

    public static TokenOf(principalId: string): string
    {
        return FakeTokens.TokenPrefix + principalId
    }

    public async Acquire(request: SourceTokenRequest): Promise<SourceToken>
    {
        this.Requests.push(request)
        await new Promise(resolve => setImmediate(resolve))
        if (this.Failing.has(request.PrincipalId)) throw new SourceTokenError(SourceTokenFailure.NoUpstreamSession)
        return new SourceToken(request.Resource, new PresentedSecret(FakeTokens.TokenOf(request.PrincipalId)), new Date(Date.now() + FakeTokens.LifetimeMs))
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
    private static readonly MaxTicks = 20

    public static Connection(mode: ConnectionCredentialMode | undefined): ResolvedConnection
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
        const [alice, bob] = await Promise.all([CallerFx.Read(adapter, CallerFx.Alice), CallerFx.Read(adapter, CallerFx.Bob)])
        assert.equal(alice, FakeTokens.TokenOf(CallerFx.Alice))
        assert.equal(bob, FakeTokens.TokenOf(CallerFx.Bob))
        assert.deepEqual(tokens.Requests.map(request => [request.TenantId, request.PrincipalId, request.Resource]).sort(),
            [[CallerFx.Tenant.Id, CallerFx.Alice, CallerFx.Resource], [CallerFx.Tenant.Id, CallerFx.Bob, CallerFx.Resource]])
        assert.equal(inner.Connected.length, 2, 'one inner adapter per principal')
        for (const opened of inner.Connected) assert.deepEqual(opened.Contexts, [opened.Secret === FakeTokens.TokenOf(CallerFx.Alice) ? CallerFx.Alice : CallerFx.Bob], 'each inner adapter serves only its own principal')
        assert.ok(inner.Opened.every(opened => opened.Secret !== CallerFx.AppSecret), 'the app credentials are never used')
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
        assert.equal(failed.status, 'rejected')
        assert.equal(caller.ClassifyFailure!((failed as PromiseRejectedResult).reason), ConnectionFailureKind.Permanent, 'a token failure is never Auth')
        assert.deepEqual(bob, { status: 'fulfilled', value: FakeTokens.TokenOf(CallerFx.Bob) })
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
