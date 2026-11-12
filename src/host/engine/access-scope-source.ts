import { createHash } from 'node:crypto'
import type { AccessScope } from '@pragmatic-tech-ai/graph'
import type { Cypher, GraphEngine, ISchemaDescription, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import { EngineSchemaCatalog } from './engine-schema-catalog.js'
import type { IGraphEngineHost } from './graph-engine-host.js'
import { ConnectorPrincipalDigest } from './principal-digest.js'
import type { PrincipalFacts } from './principal-facts.js'

/** What one caller may see and write on a graph engine: the only place its access is decided. */
export interface IGraphScope
{
    /** Passed to every read and write the caller runs on the engine; endpoints never filter or mask on their own. */
    readonly Scope: AccessScope
    /**
     * Where the caller's CREATEs go, stamped from the acting principal's facts (owned concepts, C3). `modelId` is the model the write is
     * confined to; a host whose placement needs one (dev) refuses its absence with InvalidArgument.
     */
    Placement(modelId?: string): Cypher.INodePlacement
    /**
     * Stable, secret-free fingerprint of everything the scope was compiled from (principal digest, tenant, a hash of
     * the claims, engine schema version, security-model generation, the prepared rules' digest), for cursors.
     */
    readonly Digest: string
}

/** Where a caller's scope comes from (AccessScopeSource). */
export interface IGraphScopeSource
{
    ScopeFor(context: AccessContext): Promise<IGraphScope>
    /**
     * Raised after the source drops its compiled scopes (the security setting was invalidated, the engine upgraded, or
     * the rules changed): every digest handed out before may be superseded, so caches keyed by a digest can drop too.
     */
    readonly Dropped: ISignal<void>
}

/** Where the scope compiler's diagnostics go (rules compiled to False, names the schema lacks). */
export interface IScopeDiagnostics
{
    ScopeDiagnostics(messages: readonly string[]): void
}

/** Reports each diagnostic as one warning on the server logger. */
export class LoggerScopeDiagnostics implements IScopeDiagnostics
{
    private static readonly Line = 'access scope: '

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public ScopeDiagnostics(messages: readonly string[]): void
    {
        for (const message of messages) this.logger.Warn(LoggerScopeDiagnostics.Line + message)
    }
}

export enum AccessScopeErrorCode
{
    /** The engine kept upgrading while the scope was compiled; a later call compiles against the settled version. */
    SchemaUnsettled = 1,
    /** A tier-1 decision (share, assign) was asked of rules built without an environment security setting (no identity). */
    NoSecuritySetting = 3,
}

export class AccessScopeError extends Error
{
    private static readonly ErrorName = 'AccessScopeError'
    private static readonly Messages: Readonly<Record<AccessScopeErrorCode, string>> = {
        [AccessScopeErrorCode.SchemaUnsettled]: 'the graph engine kept upgrading while its access scope was compiled',
        [AccessScopeErrorCode.NoSecuritySetting]: 'the environment has no security setting: identity is not configured',
    }

    public constructor(public readonly Code: AccessScopeErrorCode)
    {
        super(AccessScopeError.Messages[Code])
        this.name = AccessScopeError.ErrorName
    }
}

/** The engine schema one scope is compiled against, with the catalog its compilers name things by. */
export class ScopeSchema
{
    public readonly Version: string
    public readonly Catalog: EngineSchemaCatalog

    public constructor(public readonly Engine: GraphEngine, public readonly Description: ISchemaDescription)
    {
        this.Version = Description.Version
        this.Catalog = new EngineSchemaCatalog(Description)
    }
}

/** The record/field part of one principal's scope, with the principal facts its placement stamps. */
export interface IScopeRecords
{
    readonly Scope: AccessScope
    readonly Diagnostics: readonly string[]
    readonly Principal: PrincipalFacts
}

/** A purpose's scope rules, prepared against one engine schema (IScopeRules.Prepare). */
export interface IPreparedRules
{
    /** The scope's record/field part for the caller (the rules hold whatever identity state it needs). */
    Records(context: AccessContext): Promise<IScopeRecords>
    /** Applied last, to the record part, before the engine validates the scope. */
    Finish(scope: AccessScope, context: AccessContext): Promise<AccessScope>
    /** Where the caller's creates go, stamped from `principal` (the record part's). */
    Placement(principal: PrincipalFacts, modelId: string | undefined): Cypher.INodePlacement
    /** Folded into every scope digest (and so the cache key): whatever else the rules compiled from. */
    readonly Digest: string
}

/**
 * What makes one purpose's scopes differ (DevScopeRules; the runtime's rules), including its identity state;
 * `Changed` drops every compiled scope. Owned by the AccessScopeSource it is given to, which disposes it.
 */
export interface IScopeRules extends IDisposable
{
    Prepare(schema: ScopeSchema): Promise<IPreparedRules>
    readonly Changed: ISignal<void>
}

/** A void change signal: the subscribe side, raised by its owner (the scope source's drop, the rules' change). */
export class VoidSignal implements ISignal<void>
{
    private readonly signal = new Signal<void>()

    public Subscribe(handler: (value: void) => void): ISubscription
    {
        return this.signal.subscribe(handler)
    }

    public Raise(): void
    {
        this.signal.emit(undefined)
    }
}

/** A principal's compiled scope for one schema version and rules digest (cached; placement is per call). */
class CompiledScope
{
    public constructor(public readonly Scope: AccessScope, public readonly Digest: string, public readonly Principal: PrincipalFacts)
    {
    }
}

class GraphScope implements IGraphScope
{
    public readonly Scope: AccessScope
    public readonly Digest: string

    public constructor(private readonly compiled: CompiledScope, private readonly rules: IPreparedRules)
    {
        this.Scope = compiled.Scope
        this.Digest = compiled.Digest
    }

    public Placement(modelId?: string): Cypher.INodePlacement
    {
        return this.rules.Placement(this.compiled.Principal, modelId)
    }
}

/**
 * Decides each caller's access to a graph engine as one engine {@link AccessScope}, for every purpose (ruling S1); the
 * engine then enforces it on every read and write. What differs per purpose comes from {@link IScopeRules}: the
 * record part is the prepared rules' `Records` (dev: unrestricted; runtime: the tier-1 scope of the environment
 * security setting), the rules' `Finish` is applied last (amendment A2: the source composes no policy or depth and
 * holds no identity state itself), and the rules place creates.
 *
 * Scopes are cached per Digest (principal digest, tenant, claims hash, engine schema version, prepared rules' digest:
 * the runtime folds the setting generation into it); the cache is dropped when the engine upgrades (host Changed) or
 * the rules change (rules Changed: the runtime raises it when the security setting is invalidated). The rules are prepared on every
 * call against the settled schema. Every compiled scope is checked by the engine itself (a read opened under it)
 * before it is handed out; record diagnostics go to {@link IScopeDiagnostics}, each message once until the cache is
 * dropped. The source owns its rules and disposes them.
 */
export class AccessScopeSource implements IGraphScopeSource, IDisposable
{
    private static readonly MaxSnapshotReads = 5
    /** At most this many compiled scopes are kept (least recently used evicted), like VisibleInstanceCache. */
    public static readonly MaxScopes = 64
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HexEncoding = 'hex'

    public readonly Dropped: ISignal<void>

    private readonly dropped = new VoidSignal()
    private readonly scopes = new Map<string, Promise<CompiledScope>>()
    private readonly subscriptions: ISubscription[] = []
    private readonly reported = new Set<string>()
    private schema: ScopeSchema | undefined

    public constructor(
        private readonly host: IGraphEngineHost,
        private readonly rules: IScopeRules,
        private readonly diagnostics: IScopeDiagnostics = new LoggerScopeDiagnostics())
    {
        this.Dropped = this.dropped
        this.subscriptions.push(host.Changed.Subscribe(() => this.Drop(true)))
        this.subscriptions.push(rules.Changed.Subscribe(() => this.Drop(false)))
    }

    public async ScopeFor(context: AccessContext): Promise<IGraphScope>
    {
        const schema = await this.Schema()
        const prepared = await this.rules.Prepare(schema)
        const digest = this.DigestOf(context, schema.Version, prepared.Digest)
        let compiled = this.scopes.get(digest)
        if (compiled !== undefined)
        {
            // most recently used last
            this.scopes.delete(digest)
            this.scopes.set(digest, compiled)
        }
        else
        {
            const built = this.Compile(context, schema, prepared, digest)
            compiled = built
            this.scopes.set(digest, built)
            if (this.scopes.size > AccessScopeSource.MaxScopes) this.scopes.delete(this.scopes.keys().next().value!)
            built.catch(() =>
            {
                if (this.scopes.get(digest) === built) this.scopes.delete(digest)
            })
        }
        return new GraphScope(await compiled, prepared)
    }

    public dispose(): void
    {
        for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
        this.rules.dispose()
        this.Drop(true)
    }

    /** How many compiled scopes are cached (bounded by {@link AccessScopeSource.MaxScopes}). */
    public get CachedScopes(): number
    {
        return this.scopes.size
    }

    /** Claims are hashed (they may carry personal data); claim-mapped roles read them, so they key the scope. */
    private DigestOf(context: AccessContext, version: string, rulesDigest: string): string
    {
        const claims = [...context.Principal.Claims].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        const claimsHash = createHash(AccessScopeSource.HashAlgorithm).update(JSON.stringify(claims)).digest(AccessScopeSource.HexEncoding)
        return JSON.stringify([ConnectorPrincipalDigest.Of(context), context.Tenant.Id, claimsHash, version, rulesDigest])
    }

    private Drop(schema: boolean): void
    {
        this.scopes.clear()
        this.reported.clear()
        if (schema) this.schema = undefined
        this.dropped.Raise()
    }

    private async Compile(context: AccessContext, schema: ScopeSchema, prepared: IPreparedRules, digest: string): Promise<CompiledScope>
    {
        const records = await prepared.Records(context)
        const scope = await prepared.Finish(records.Scope, context)
        // the engine's own scope validation (ruling R63): a scope it would reject is never handed out
        const reader = await schema.Engine.BeginRead(scope)
        reader.dispose()
        this.Report(records.Diagnostics)
        return new CompiledScope(scope, digest, records.Principal)
    }

    private Report(messages: readonly string[]): void
    {
        const fresh = messages.filter(message => !this.reported.has(message))
        if (fresh.length === 0) return
        for (const message of fresh) this.reported.add(message)
        this.diagnostics.ScopeDiagnostics(fresh)
    }

    /** The engine and the description it runs, read so the description belongs to the engine's version. */
    private async Schema(): Promise<ScopeSchema>
    {
        for (let attempt = 0; attempt < AccessScopeSource.MaxSnapshotReads; attempt++)
        {
            const engine = await this.host.Engine()
            if (this.schema !== undefined && this.schema.Engine === engine && this.schema.Version === engine.SchemaVersion) return this.schema
            const description = await this.host.Description()
            if (description.Version === engine.SchemaVersion)
            {
                this.schema = new ScopeSchema(engine, description)
                return this.schema
            }
        }
        throw new AccessScopeError(AccessScopeErrorCode.SchemaUnsettled)
    }
}
