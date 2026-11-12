import { createHash } from 'node:crypto'
import { ConnectionFailureKind } from '@pragmatic-tech-ai/todl'
import type { AdapterResolutionRequest, DataSourceKind, ExternalRecord, IDataSourceAdapter, IDataSourceAdapterFactory, IDataSourceAdapterProvider, IDataSourceContext, PageQuery, PageSlice, QueryRequest, ResolvedConnection, WriteBatch, WriteResult } from '@pragmatic-tech-ai/todl'
import { SourceTokenRequest } from '@pragmatic-tech-ai/todl-identity'
import type { ISourceTokenProvider, Tenant } from '@pragmatic-tech-ai/todl-identity'

/** How a connector connection authenticates to its source (spec section 6): its connector config's `credentials`. */
export enum ConnectionCredentialMode
{
    /** A connection string / service account (the default): the caller's context is ignored. */
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
}

/** A caller's-identity connection refused a call; the message never carries a token. */
export class CallerCredentialError extends Error
{
    private static readonly ErrorName = 'CallerCredentialError'
    private static readonly Messages: Readonly<Record<CallerCredentialErrorCode, string>> = {
        [CallerCredentialErrorCode.AnonymousContext]: 'a caller\'s-identity connection refuses a call without a caller',
        [CallerCredentialErrorCode.NoTokenResource]: 'a caller\'s-identity connection must name its token resource',
        [CallerCredentialErrorCode.PagingUnsupported]: 'the caller\'s-identity connection does not support paged reads',
    }

    public constructor(public readonly Code: CallerCredentialErrorCode)
    {
        super(CallerCredentialError.Messages[Code])
        this.name = CallerCredentialError.ErrorName
    }
}

/** One principal's inner connection: opened with its source token (held only as a digest here). */
class PrincipalConnection
{
    public constructor(public readonly TokenDigest: string, public readonly Adapter: IDataSourceAdapter)
    {
    }
}

/** What a caller's-identity connection reports of itself before any caller opened it (the probe's flags). */
interface ICapabilities
{
    readonly CanTransact: boolean
    readonly CanVersion: boolean
    readonly CanPage: boolean
    readonly SourceManagesVersions: boolean
}

/**
 * A connection in caller's-identity mode (spec section 6, PR12; ruling R28). Each Query / QueryPage / Apply acquires
 * the caller's source token (`SourceTokenRequest(tenant, context.Key, resource)`) and runs on that principal's own
 * inner adapter, opened with the token as its secret; the inner adapter is reopened when the token is renewed. Inner
 * adapters are keyed by the context key and never lent across principals; the connection's own secret (app
 * credentials) is never used. A missing or anonymous context, and a failed acquisition, fail the call.
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
    private disposed = false

    public constructor(
        private readonly inner: IDataSourceAdapterFactory,
        private readonly tokens: ISourceTokenProvider,
        private readonly tenant: Tenant,
        private readonly connection: ResolvedConnection,
        private readonly resource: string,
        private readonly capabilities: ICapabilities,
        private readonly registry: Set<CallerCredentialAdapter>)
    {
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
        return this.Run(context, adapter => adapter.Apply(batch, context))
    }

    /** Always Permanent (never Auth, never Transient): see the class remarks. */
    public ClassifyFailure(_error: unknown): ConnectionFailureKind
    {
        return ConnectionFailureKind.Permanent
    }

    /** Drops and disposes `principalId`'s inner adapter (deprovisioning, sign-out: R27); its next call reconnects. */
    public async Forget(principalId: string): Promise<void>
    {
        const pending = this.connections.get(principalId)
        if (pending === undefined) return
        this.connections.delete(principalId)
        await CallerCredentialAdapter.DisposeQuietly(pending)
    }

    /** Disposes every principal's inner adapter. Idempotent. */
    public async Dispose(): Promise<void>
    {
        if (this.disposed) return
        this.disposed = true
        this.registry.delete(this)
        const pending = [...this.connections.values()]
        this.connections.clear()
        await Promise.all(pending.map(opening => CallerCredentialAdapter.DisposeQuietly(opening)))
    }

    private async Run<T>(context: IDataSourceContext | undefined, op: (adapter: IDataSourceAdapter) => Promise<T>): Promise<T>
    {
        const key = context?.Key ?? ''
        if (key.length === 0) throw new CallerCredentialError(CallerCredentialErrorCode.AnonymousContext)
        const token = await this.tokens.Acquire(new SourceTokenRequest(this.tenant.Id, key, this.resource))
        const secret = token.Value.Reveal()
        const connection = await this.ConnectionFor(key, secret)
        try
        {
            return await op(connection.Adapter)
        }
        catch (error)
        {
            // the source refused this caller's token: only this principal reconnects, nobody else's adapter is touched
            if (connection.Adapter.ClassifyFailure?.(error) === ConnectionFailureKind.Auth) await this.Drop(key, connection)
            throw error
        }
    }

    /** `key`'s inner adapter for the token `secret`: the held one while the token is unchanged, else a fresh one. */
    private async ConnectionFor(key: string, secret: string): Promise<PrincipalConnection>
    {
        const digest = createHash(CallerCredentialAdapter.DigestAlgorithm).update(secret).digest(CallerCredentialAdapter.DigestEncoding)
        for (;;)
        {
            const pending = this.connections.get(key)
            if (pending === undefined)
            {
                const opening = this.Open(digest, secret)
                this.connections.set(key, opening)
                opening.catch(() =>
                {
                    if (this.connections.get(key) === opening) this.connections.delete(key)
                })
                return opening
            }
            let held: PrincipalConnection
            try
            {
                held = await pending
            }
            catch
            {
                if (this.connections.get(key) === pending) this.connections.delete(key)
                continue
            }
            if (held.TokenDigest === digest) return held
            // the token was renewed: the principal's adapter is reopened with the new one
            await this.Drop(key, held)
        }
    }

    private async Open(digest: string, secret: string): Promise<PrincipalConnection>
    {
        const adapter = await this.inner.Open({ Kind: this.connection.Kind, Config: this.connection.Config, Secret: secret })
        return new PrincipalConnection(digest, adapter)
    }

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
        await CallerCredentialAdapter.DisposeQuietly(pending)
    }

    private static async DisposeQuietly(pending: Promise<PrincipalConnection>): Promise<void>
    {
        try
        {
            await (await pending).Adapter.Dispose()
        }
        catch
        {
            // a failed open produced no adapter, or its Dispose threw; it is dropped either way
        }
    }
}

/**
 * Wraps a data-source adapter factory (PR12): a connection whose config says `credentials = caller` opens a
 * {@link CallerCredentialAdapter} over the identity pack's source tokens; every other connection (dedicated
 * credentials, the default) gets the inner adapter unchanged and its calls' context is ignored. The caller's-identity
 * adapter reads its capabilities from a probe opened without any secret and disposed at once (never called).
 */
export class CallerCredentialAdapterFactory implements IDataSourceAdapterFactory
{
    /** The connector config key naming the credential mode ({@link ConnectionCredentialMode}). */
    public static readonly CredentialsKey = 'credentials'
    /** The connector config key naming the source-token resource (audience) of a caller's-identity connection. */
    public static readonly TokenResourceKey = 'tokenResource'

    public readonly Kind: DataSourceKind

    private readonly open = new Set<CallerCredentialAdapter>()

    public constructor(private readonly inner: IDataSourceAdapterFactory, private readonly tokens: ISourceTokenProvider, private readonly tenant: Tenant)
    {
        this.Kind = inner.Kind
    }

    /** Whether `connection` authenticates with the caller's identity. */
    public static IsCallerMode(connection: ResolvedConnection): boolean
    {
        return connection.Config[CallerCredentialAdapterFactory.CredentialsKey] === ConnectionCredentialMode.Caller
    }

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        if (!CallerCredentialAdapterFactory.IsCallerMode(connection)) return this.inner.Open(connection)
        const resource = connection.Config[CallerCredentialAdapterFactory.TokenResourceKey]
        if (resource === undefined || resource.length === 0) throw new CallerCredentialError(CallerCredentialErrorCode.NoTokenResource)
        const capabilities = await this.Probe(connection)
        const adapter = new CallerCredentialAdapter(this.inner, this.tokens, this.tenant, connection, resource, capabilities, this.open)
        this.open.add(adapter)
        return adapter
    }

    /** Drops `principalId`'s inner adapters on every open caller's-identity connection of this factory (R27). */
    public async Forget(principalId: string): Promise<void>
    {
        await Promise.all([...this.open].map(adapter => adapter.Forget(principalId)))
    }

    /** The inner adapter's flags for this connection, read from an adapter opened with no secret and never called. */
    private async Probe(connection: ResolvedConnection): Promise<ICapabilities>
    {
        const probe = await this.inner.Open({ Kind: connection.Kind, Config: connection.Config })
        try
        {
            return {
                CanTransact: probe.CanTransact ?? false,
                CanVersion: probe.CanVersion ?? false,
                CanPage: probe.CanPage ?? false,
                SourceManagesVersions: probe.SourceManagesVersions ?? false,
            }
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
