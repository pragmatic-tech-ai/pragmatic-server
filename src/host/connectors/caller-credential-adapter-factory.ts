import { createHash } from 'node:crypto'
import { ConnectionFailureKind } from '@pragmatic-tech-ai/todl'
import type { AdapterResolutionRequest, DataSourceKind, ExternalRecord, IDataSourceAdapter, IDataSourceAdapterFactory, IDataSourceAdapterProvider, IDataSourceContext, PageQuery, PageSlice, QueryRequest, ResolvedConnection, WriteBatch, WriteResult } from '@pragmatic-tech-ai/todl'
import { CypherAdapterFactory, DocumentAdapterFactory, RestAdapterFactory, SqlAdapterFactory } from '@pragmatic-tech-ai/todl-connectors-host'
import { SourceTokenRequest } from '@pragmatic-tech-ai/todl-identity'
import type { ISourceTokenProvider, Tenant } from '@pragmatic-tech-ai/todl-identity'

/** How a connector connection authenticates to its source (spec section 6): its connector config's `credentials`. */
export enum ConnectionCredentialMode
{
    /** A connection string / service account (the default when `credentials` is absent): the context is ignored. */
    Dedicated = 'dedicated',
    /** The caller's identity: an IdP token exchanged for a per-user source token (`tokenResource` names its audience). */
    Caller = 'caller',
}

export enum CallerCredentialErrorCode
{
    /** The call carried no caller (missing or anonymous context). */
    AnonymousContext = 1,
    /** A caller's-identity connection names no `tokenResource`. */
    NoTokenResource = 2,
    /** The inner adapter cannot serve keyset-paged reads. */
    PagingUnsupported = 3,
    /** The connection's `credentials` names no known mode (never read as dedicated: that would widen access). */
    UnknownCredentialMode = 4,
    /**
     * A write reached a connection whose capabilities were first learned by that very call and say the source manages
     * its own versions: TODL's version bumping may already have bumped the batch, so it is refused, never sent.
     */
    CapabilitiesUnsettled = 5,
}

/** A caller's-identity connection refused a call; the message never carries a token. */
export class CallerCredentialError extends Error
{
    private static readonly ErrorName = 'CallerCredentialError'
    private static readonly Messages: Readonly<Record<CallerCredentialErrorCode, string>> = {
        [CallerCredentialErrorCode.AnonymousContext]: 'a caller\'s-identity connection refuses a call without a caller',
        [CallerCredentialErrorCode.NoTokenResource]: 'a caller\'s-identity connection must name its token resource',
        [CallerCredentialErrorCode.PagingUnsupported]: 'the caller\'s-identity connection does not support paged reads',
        [CallerCredentialErrorCode.UnknownCredentialMode]: 'the connection names an unknown credential mode',
        [CallerCredentialErrorCode.CapabilitiesUnsettled]: 'the caller\'s-identity connection learned its capabilities on this write; retry it',
    }

    public constructor(public readonly Code: CallerCredentialErrorCode)
    {
        super(CallerCredentialError.Messages[Code])
        this.name = CallerCredentialError.ErrorName
    }
}

/**
 * One principal's inner connection, opened with its source token (held only as a digest here). Calls `Enter` / `Exit`
 * it; once `Retire`d (token renewed, principal revoked) it is disposed when its last in-flight call ends, so a renewal
 * never cuts off a call of the same principal still running on it.
 */
class PrincipalConnection
{
    private inFlight = 0
    private retired = false

    public constructor(public readonly TokenDigest: string, public readonly Adapter: IDataSourceAdapter)
    {
    }

    public Enter(): void
    {
        this.inFlight++
    }

    public async Exit(): Promise<void>
    {
        this.inFlight--
        await this.DisposeIfDrained()
    }

    public async Retire(): Promise<void>
    {
        this.retired = true
        await this.DisposeIfDrained()
    }

    private async DisposeIfDrained(): Promise<void>
    {
        if (!this.retired || this.inFlight > 0) return
        try
        {
            await this.Adapter.Dispose()
        }
        catch
        {
            // a dead connection's Dispose may throw; it is dropped either way
        }
    }
}

/** The flags a caller's-identity connection reports (known up front, or latched from the first principal's inner adapter). */
export class Capabilities
{
    public constructor(
        public readonly CanTransact: boolean,
        public readonly CanVersion: boolean,
        public readonly CanPage: boolean,
        public readonly SourceManagesVersions: boolean)
    {
    }

    /** Before any caller opened the connection: the weakest guarantee (absent flags are false in TODL). */
    public static readonly None = new Capabilities(false, false, false, false)

    public static Of(adapter: IDataSourceAdapter): Capabilities
    {
        return new Capabilities(adapter.CanTransact ?? false, adapter.CanVersion ?? false, adapter.CanPage ?? false, adapter.SourceManagesVersions ?? false)
    }
}

/**
 * A connection in caller's-identity mode (spec section 6, PR12; ruling R28). Each Query / QueryPage / Apply acquires
 * the caller's source token (`SourceTokenRequest(tenant, context.Key, resource)`) and runs on that principal's own
 * inner adapter, opened with the token as its secret; the inner adapter is reopened when the token is renewed (the old
 * one is disposed once its in-flight calls end). Inner adapters are keyed by the context key and never lent across
 * principals; the connection's own secret (app credentials) is never used, and no adapter is ever opened without a
 * caller's token. A missing or anonymous context, and a failed acquisition, fail the call.
 *
 * Capabilities (ruling R36): known when the factory gives them up front (CallerCredentialAdapterFactory: the built-in
 * factories, read from an adapter opened without a secret, which they never connect or authenticate at); otherwise
 * latched from the first principal's inner adapter (same connection config, so the same flags), reporting the weakest
 * guarantee (all false) until then. TODL reads them live: before the latch a transactional write is refused explicitly
 * (UnsupportedExternalChange) and a read is unpaged; a write whose own call latched `SourceManagesVersions` true is
 * refused (`CapabilitiesUnsettled`), so a version bumped by TODL is never sent to a source that assigns its own.
 *
 * TODL's ReconnectingAdapter shares this adapter across callers and reopens it for everyone on an Auth (or repeated
 * Transient) classification, so every failure here is one caller's and is classified Permanent (ruling R28): no
 * caller, a SourceTokenError, or the source failing one caller's call fails that call only, and the shared adapter
 * is never reopened under the other callers. An inner Auth failure drops only that principal's inner adapter (its
 * next call reconnects with a fresh one).
 */
export class CallerCredentialAdapter implements IDataSourceAdapter
{
    private static readonly DigestAlgorithm = 'sha256'
    private static readonly DigestEncoding = 'hex'

    private readonly connections = new Map<string, Promise<PrincipalConnection>>()
    private capabilities: Capabilities
    private disposed = false

    public constructor(
        private readonly inner: IDataSourceAdapterFactory,
        private readonly tokens: ISourceTokenProvider,
        private readonly tenant: Tenant,
        private readonly connection: ResolvedConnection,
        private readonly resource: string,
        private readonly registry: Set<CallerCredentialAdapter>,
        capabilities: Capabilities)
    {
        this.capabilities = capabilities
    }

    public get CanTransact(): boolean
    {
        return this.capabilities.CanTransact
    }

    public get CanVersion(): boolean
    {
        return this.capabilities.CanVersion
    }

    public get CanPage(): boolean
    {
        return this.capabilities.CanPage
    }

    public get SourceManagesVersions(): boolean
    {
        return this.capabilities.SourceManagesVersions
    }

    public Query(request: QueryRequest, context?: IDataSourceContext): Promise<readonly ExternalRecord[]>
    {
        return this.Run(context, adapter => adapter.Query(request, context))
    }

    public QueryPage(request: QueryRequest, page: PageQuery, context?: IDataSourceContext): Promise<PageSlice>
    {
        return this.Run(context, adapter =>
        {
            if (adapter.QueryPage === undefined) throw new CallerCredentialError(CallerCredentialErrorCode.PagingUnsupported)
            return adapter.QueryPage(request, page, context)
        })
    }

    public Apply(batch: WriteBatch, context?: IDataSourceContext): Promise<WriteResult>
    {
        const unsettled = this.capabilities === Capabilities.None
        return this.Run(context, adapter =>
        {
            // TODL's version bumping read SourceManagesVersions before this call latched it (R36 (a))
            if (unsettled && this.capabilities.SourceManagesVersions) throw new CallerCredentialError(CallerCredentialErrorCode.CapabilitiesUnsettled)
            return adapter.Apply(batch, context)
        })
    }

    /** Always Permanent (never Auth, never Transient): see the class remarks. */
    public ClassifyFailure(_error: unknown): ConnectionFailureKind
    {
        return ConnectionFailureKind.Permanent
    }

    /** Retires `principalId`'s inner adapter (deprovisioning, sign-out: R27); its next call reconnects with a fresh token. */
    public async Forget(principalId: string): Promise<void>
    {
        const pending = this.connections.get(principalId)
        if (pending === undefined) return
        this.connections.delete(principalId)
        await CallerCredentialAdapter.RetireQuietly(pending)
    }

    /** Disposes every principal's inner adapter. Idempotent. */
    public async Dispose(): Promise<void>
    {
        if (this.disposed) return
        this.disposed = true
        this.registry.delete(this)
        const pending = [...this.connections.values()]
        this.connections.clear()
        await Promise.all(pending.map(async opening =>
        {
            try
            {
                await (await opening).Adapter.Dispose()
            }
            catch
            {
                // a failed open produced no adapter, or its Dispose threw
            }
        }))
    }

    private async Run<T>(context: IDataSourceContext | undefined, op: (adapter: IDataSourceAdapter) => Promise<T>): Promise<T>
    {
        const key = context?.Key ?? ''
        if (key.length === 0) throw new CallerCredentialError(CallerCredentialErrorCode.AnonymousContext)
        const token = await this.tokens.Acquire(new SourceTokenRequest(this.tenant.Id, key, this.resource))
        const secret = token.Value.Reveal()
        // entered by ConnectionFor: a renewal racing this call cannot dispose the adapter under it
        const connection = await this.ConnectionFor(key, secret)
        try
        {
            return await op(connection.Adapter)
        }
        catch (error)
        {
            // the source refused this caller's token: only this principal reconnects, nobody else's adapter is touched
            // (a refusal of this adapter's own is not the source's: it is never classified by the inner adapter)
            if (!(error instanceof CallerCredentialError) && connection.Adapter.ClassifyFailure?.(error) === ConnectionFailureKind.Auth) await this.Drop(key, connection)
            throw error
        }
        finally
        {
            await connection.Exit()
        }
    }

    /**
     * `key`'s inner adapter for the token `secret`, entered (the caller exits it): the held one while the token is
     * unchanged, else a fresh one (the old one is retired).
     */
    private async ConnectionFor(key: string, secret: string): Promise<PrincipalConnection>
    {
        const digest = createHash(CallerCredentialAdapter.DigestAlgorithm).update(secret).digest(CallerCredentialAdapter.DigestEncoding)
        for (;;)
        {
            let pending = this.connections.get(key)
            const opened = pending === undefined
            if (pending === undefined)
            {
                pending = this.Open(digest, secret)
                this.connections.set(key, pending)
            }
            let held: PrincipalConnection
            try
            {
                held = await pending
            }
            catch (error)
            {
                if (this.connections.get(key) === pending) this.connections.delete(key)
                // this call's own open failed: it fails; another call's failed open is retried with this call's token
                if (opened) throw error
                continue
            }
            // replaced meanwhile (a renewal or a revoke): look again
            if (this.connections.get(key) !== pending) continue
            if (held.TokenDigest === digest)
            {
                held.Enter()
                return held
            }
            // the token was renewed: the principal's adapter is reopened with the new one, the old drains
            await this.Drop(key, held)
        }
    }

    private async Open(digest: string, secret: string): Promise<PrincipalConnection>
    {
        const adapter = await this.inner.Open({ Kind: this.connection.Kind, Config: this.connection.Config, Secret: secret })
        if (this.capabilities === Capabilities.None) this.capabilities = Capabilities.Of(adapter)
        return new PrincipalConnection(digest, adapter)
    }

    /** Retires `connection` if it is still `key`'s current one. */
    private async Drop(key: string, connection: PrincipalConnection): Promise<void>
    {
        const pending = this.connections.get(key)
        if (pending === undefined) return
        let held: PrincipalConnection | undefined
        try
        {
            held = await pending
        }
        catch
        {
            held = undefined
        }
        if (held !== connection || this.connections.get(key) !== pending) return
        this.connections.delete(key)
        await connection.Retire()
    }

    private static async RetireQuietly(pending: Promise<PrincipalConnection>): Promise<void>
    {
        let connection: PrincipalConnection
        try
        {
            connection = await pending
        }
        catch
        {
            // a failed open produced no adapter
            return
        }
        await connection.Retire()
    }
}

/**
 * Wraps a data-source adapter factory (PR12). A connection's `credentials` decides: absent or `dedicated` gets the
 * inner adapter unchanged (its calls' context is ignored); `caller` opens a {@link CallerCredentialAdapter} over the
 * identity pack's source tokens; any other value is refused (`UnknownCredentialMode`), never read as dedicated.
 */
export class CallerCredentialAdapterFactory implements IDataSourceAdapterFactory
{
    /** The connector config key naming the credential mode ({@link ConnectionCredentialMode}). */
    public static readonly CredentialsKey = 'credentials'
    /** The connector config key naming the source-token resource (audience) of a caller's-identity connection. */
    public static readonly TokenResourceKey = 'tokenResource'

    public readonly Kind: DataSourceKind

    /**
     * Factories whose Open neither connects nor authenticates (verified in connectors-host / TODL source, ruling R36):
     * their capabilities are read from an adapter opened without a secret, disposed at once and never called. Any other
     * factory (adapter packs, test sources) is never opened without a caller's token.
     */
    private static readonly LazyOpenFactories: readonly (abstract new (...args: never[]) => IDataSourceAdapterFactory)[] = [SqlAdapterFactory, RestAdapterFactory, CypherAdapterFactory, DocumentAdapterFactory]

    private readonly open = new Set<CallerCredentialAdapter>()

    public constructor(private readonly inner: IDataSourceAdapterFactory, private readonly tokens: ISourceTokenProvider, private readonly tenant: Tenant)
    {
        this.Kind = inner.Kind
    }

    /** The connection's credential mode: absent (or empty) is Dedicated; an unknown value throws `UnknownCredentialMode`. */
    public static ModeOf(connection: ResolvedConnection): ConnectionCredentialMode
    {
        const mode = connection.Config[CallerCredentialAdapterFactory.CredentialsKey]
        if (mode === undefined || mode.length === 0 || mode === ConnectionCredentialMode.Dedicated) return ConnectionCredentialMode.Dedicated
        if (mode === ConnectionCredentialMode.Caller) return ConnectionCredentialMode.Caller
        throw new CallerCredentialError(CallerCredentialErrorCode.UnknownCredentialMode)
    }

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        if (CallerCredentialAdapterFactory.ModeOf(connection) === ConnectionCredentialMode.Dedicated) return this.inner.Open(connection)
        const resource = connection.Config[CallerCredentialAdapterFactory.TokenResourceKey]
        if (resource === undefined || resource.length === 0) throw new CallerCredentialError(CallerCredentialErrorCode.NoTokenResource)
        const adapter = new CallerCredentialAdapter(this.inner, this.tokens, this.tenant, connection, resource, this.open, await this.KnownCapabilities(connection))
        this.open.add(adapter)
        return adapter
    }

    /** Retires `principalId`'s inner adapters on every open caller's-identity connection of this factory (R27). */
    public async Forget(principalId: string): Promise<void>
    {
        await Promise.all([...this.open].map(adapter => adapter.Forget(principalId)))
    }

    /** A lazily-opening factory's flags for `connection` (a secret-less open, never called); else None (latched later). */
    private async KnownCapabilities(connection: ResolvedConnection): Promise<Capabilities>
    {
        if (!CallerCredentialAdapterFactory.LazyOpenFactories.some(kind => this.inner instanceof kind)) return Capabilities.None
        const probe = await this.inner.Open({ Kind: connection.Kind, Config: connection.Config })
        try
        {
            return Capabilities.Of(probe)
        }
        finally
        {
            await probe.Dispose()
        }
    }
}

/** What wraps every factory a provider resolves (CallerCredentials). */
export interface ICallerCredentialWrapper
{
    Wrap(factory: IDataSourceAdapterFactory): IDataSourceAdapterFactory
}

/** The pack-management members ConnectorsHost duck-types on its provider (NpmAdapterPackProvider has them). */
export interface IManagedAdapterProvider extends IDataSourceAdapterProvider
{
    Invalidate?(name: string): Promise<void>
    AllowScripts?(name: string): Promise<void>
    DenyScripts?(name: string): Promise<void>
    ListScriptAllowlist?(): Promise<readonly string[]>
    Dispose?(): Promise<void>
}

/**
 * Wraps an adapter-pack provider: every factory it resolves is wrapped by `credentials` (PR12), so a pack's
 * caller's-identity connection is held to the same rules. The pack-management members are forwarded as the inner
 * provider has them (absent stays absent, so ConnectorsHost still reports ProviderNotConfigured).
 */
export class CallerCredentialAdapterProvider implements IManagedAdapterProvider
{
    public readonly Invalidate?: (name: string) => Promise<void>
    public readonly AllowScripts?: (name: string) => Promise<void>
    public readonly DenyScripts?: (name: string) => Promise<void>
    public readonly ListScriptAllowlist?: () => Promise<readonly string[]>
    public readonly Dispose?: () => Promise<void>

    public constructor(private readonly inner: IManagedAdapterProvider, private readonly credentials: ICallerCredentialWrapper)
    {
        this.Invalidate = inner.Invalidate?.bind(inner)
        this.AllowScripts = inner.AllowScripts?.bind(inner)
        this.DenyScripts = inner.DenyScripts?.bind(inner)
        this.ListScriptAllowlist = inner.ListScriptAllowlist?.bind(inner)
        this.Dispose = inner.Dispose?.bind(inner)
    }

    public async Resolve(request: AdapterResolutionRequest): Promise<IDataSourceAdapterFactory>
    {
        return this.credentials.Wrap(await this.inner.Resolve(request))
    }
}
