import { createHash } from 'node:crypto'
import { AccessDefault, AccessScope } from '@pragmatic-tech-ai/graph'
import type { CellValue, Cypher, GraphEngine, ISchemaDescription, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import type { Repository } from '@pragmatic-tech-ai/todl'
import { PolicyScopeCompiler, TodlNodePlacement } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'
import { ConnectorPrincipalDigest } from '../connector-read-authorization.js'
import { AccessScopeConjunction } from './access-scope-conjunction.js'
import { DepthScopeCompiler } from './depth-scope-compiler.js'
import type { IPlacementDefaults } from './depth-scope-compiler.js'
import type { IDevGraphEngine } from './dev-graph-engine-host.js'
import { EngineSchemaCatalog } from './engine-schema-catalog.js'
import { PrincipalFacts } from './principal-facts.js'
import { SavedMemberReader } from './saved-member-reader.js'

/** What one caller may see and write on the dev graph engine: the only place dev access is decided. */
export interface IDevScope
{
    /** Passed to every read and write the caller runs on the engine; endpoints never filter or mask on their own. */
    readonly Scope: AccessScope
    /** Where the caller's CREATEs in `modelId` go, stamped with the security model's create defaults. */
    Placement(modelId: string): Cypher.INodePlacement
    /**
     * Stable, secret-free fingerprint of everything the scope was compiled from (principal digest, tenant, a hash of
     * the claims, engine schema version, security-model generation), for cursors.
     */
    readonly Digest: string
}

/** Where a caller's dev scope comes from (DevAccessScopeSource). */
export interface IDevScopeSource
{
    ScopeFor(context: AccessContext): Promise<IDevScope>
    /**
     * Raised after the source drops its compiled scopes (the security model was invalidated, or the engine upgraded):
     * every digest handed out before may be superseded, so caches keyed by a digest can drop too.
     */
    readonly Dropped: ISignal<void>
}

/** The tenant security the scope source reads (TenantReadAuthorization): the cached evaluator and its reload signal. */
export interface ITenantSecuritySource
{
    EvaluatorForContext(context: AccessContext): Promise<AccessDepthEvaluator>
    /** False when the tenant has no security model (its evaluator is DenyAll). */
    HasSecurityModelFor(context: AccessContext): Promise<boolean>
    /** Raised after a tenant's security model is invalidated (reloaded on next use). */
    readonly Invalidated: ISignal<string>
}

/** Where the scope compilers' diagnostics go (policy leaves the engine cannot express, depth rules compiled to False). */
export interface IDevScopeDiagnostics
{
    ScopeDiagnostics(messages: readonly string[]): void
}

/** Reports each diagnostic as one warning on the server logger. */
export class LoggerDevScopeDiagnostics implements IDevScopeDiagnostics
{
    private static readonly Line = 'dev access scope: '

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public ScopeDiagnostics(messages: readonly string[]): void
    {
        for (const message of messages) this.logger.Warn(LoggerDevScopeDiagnostics.Line + message)
    }
}

export enum DevAccessScopeErrorCode
{
    /** The engine kept upgrading while the scope was compiled; a later call compiles against the settled version. */
    SchemaUnsettled = 1,
    /** Identity is configured but no tenant security source was given. */
    MissingSecuritySource,
}

export class DevAccessScopeError extends Error
{
    private static readonly ErrorName = 'DevAccessScopeError'
    private static readonly Messages: Readonly<Record<DevAccessScopeErrorCode, string>> = {
        [DevAccessScopeErrorCode.SchemaUnsettled]: 'the dev graph engine kept upgrading while its access scope was compiled',
        [DevAccessScopeErrorCode.MissingSecuritySource]: 'identity is configured but no tenant security source was given',
    }

    public constructor(public readonly Code: DevAccessScopeErrorCode)
    {
        super(DevAccessScopeError.Messages[Code])
        this.name = DevAccessScopeError.ErrorName
    }
}

/** The engine schema one scope is compiled against, with what is derived from it once per version. */
class SchemaState
{
    public readonly Version: string
    public readonly Catalog: EngineSchemaCatalog
    public readonly Policies: PolicyScopeCompiler

    public constructor(public readonly Engine: GraphEngine, public readonly Description: ISchemaDescription, repository: Repository)
    {
        this.Version = Description.Version
        this.Catalog = new EngineSchemaCatalog(Description)
        // validated against the description (ruling P4-l): a policy never names what the engine lacks
        this.Policies = PolicyScopeCompiler.FromRepository(repository, Description)
    }
}

/** No identity: nothing is stamped on a create. */
class NoPlacementDefaults implements IPlacementDefaults
{
    public static readonly Instance = new NoPlacementDefaults()
    private static readonly None: ReadonlyMap<string, CellValue> = new Map()

    public Defaults(): ReadonlyMap<string, CellValue>
    {
        return NoPlacementDefaults.None
    }
}

/** The subscribe side of the scope source's drop signal. */
class ScopesDropped implements ISignal<void>
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

/** A principal's compiled scope for one schema version and security generation (cached; placement is per call). */
class CompiledScope
{
    public constructor(public readonly Scope: AccessScope, public readonly Digest: string, public readonly Defaults: IPlacementDefaults)
    {
    }
}

/** TODL placement (the model's namespace and the model as owner) plus the principal's create defaults. */
class DevNodePlacement implements Cypher.INodePlacement
{
    public constructor(private readonly inner: TodlNodePlacement, private readonly defaults: IPlacementDefaults)
    {
    }

    public Place(concept: string, properties: ReadonlyMap<string, CellValue>): Cypher.INodePlace
    {
        const place = this.inner.Place(concept, properties)
        const defaults = this.defaults.Defaults(concept)
        return defaults.size === 0 ? place : { ...place, Defaults: defaults }
    }
}

class DevScope implements IDevScope
{
    public readonly Scope: AccessScope
    public readonly Digest: string

    public constructor(private readonly compiled: CompiledScope, private readonly solutionName: string | undefined)
    {
        this.Scope = compiled.Scope
        this.Digest = compiled.Digest
    }

    public Placement(modelId: string): Cypher.INodePlacement
    {
        // a model id with no namespace prefix falls back to the solution name (as the dev draft does), else to itself
        const namespace = SavedMemberReader.NamespaceOf(modelId, this.solutionName ?? modelId)
        return new DevNodePlacement(new TodlNodePlacement(modelId, namespace), this.compiled.Defaults)
    }
}

/**
 * Decides each caller's dev access as one engine {@link AccessScope}: the TODL policies (PolicyScopeCompiler over the
 * engine's current repository and description) AND the tenant security model's access depth and field security
 * (DepthScopeCompiler), deny-wins (AccessScopeConjunction). The engine then enforces it on every read and write.
 *
 * - No identity subsystem: the policy rows only, Default Allow, no write rules (today's dev writes are open without
 *   identity; reads are policy-filtered).
 * - Identity configured: policy AND depth; a tenant with no security model is deny-all (fail-closed, as today).
 *
 * Scopes are cached per Digest (principal digest, tenant, claims hash, engine schema version, security generation);
 * the generation is bumped and the cache dropped when the security model is invalidated
 * (TenantReadAuthorization.Invalidated), and the cache dropped when the engine upgrades (host Changed). Every compiled
 * scope is checked by the engine itself (a read opened under it) before it is handed out; compiler diagnostics go to
 * {@link IDevScopeDiagnostics}, each message once until the cache is dropped.
 */
export class DevAccessScopeSource implements IDevScopeSource, IDisposable
{
    private static readonly MaxSnapshotReads = 5
    /** At most this many compiled scopes are kept (least recently used evicted), like VisibleInstanceCache. */
    public static readonly MaxScopes = 64
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HexEncoding = 'hex'

    public readonly Dropped: ISignal<void>

    private readonly dropped = new ScopesDropped()
    private readonly scopes = new Map<string, Promise<CompiledScope>>()
    private readonly subscriptions: ISubscription[] = []
    private readonly reported = new Set<string>()
    private schema: SchemaState | undefined
    private generation = 0

    public constructor(
        private readonly host: IDevGraphEngine,
        private readonly readAuthorization: ITenantSecuritySource | undefined,
        private readonly identityConfigured: boolean,
        private readonly solutionName: () => Promise<string | undefined> = () => Promise.resolve(undefined),
        private readonly diagnostics: IDevScopeDiagnostics = new LoggerDevScopeDiagnostics())
    {
        this.Dropped = this.dropped
        if (identityConfigured && readAuthorization === undefined) throw new DevAccessScopeError(DevAccessScopeErrorCode.MissingSecuritySource)
        this.subscriptions.push(host.Changed.Subscribe(() => this.Drop(true)))
        if (readAuthorization !== undefined)
        {
            this.subscriptions.push(readAuthorization.Invalidated.Subscribe(() =>
            {
                this.generation += 1
                this.Drop(false)
            }))
        }
    }

    public async ScopeFor(context: AccessContext): Promise<IDevScope>
    {
        const schema = await this.Schema()
        const digest = this.DigestOf(context, schema.Version)
        let compiled = this.scopes.get(digest)
        if (compiled !== undefined)
        {
            // most recently used last
            this.scopes.delete(digest)
            this.scopes.set(digest, compiled)
        }
        else
        {
            const built = this.Compile(context, schema, digest)
            compiled = built
            this.scopes.set(digest, built)
            if (this.scopes.size > DevAccessScopeSource.MaxScopes) this.scopes.delete(this.scopes.keys().next().value!)
            built.catch(() =>
            {
                if (this.scopes.get(digest) === built) this.scopes.delete(digest)
            })
        }
        return new DevScope(await compiled, await this.solutionName())
    }

    public dispose(): void
    {
        for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
        this.Drop(true)
    }

    /** How many compiled scopes are cached (bounded by {@link DevAccessScopeSource.MaxScopes}). */
    public get CachedScopes(): number
    {
        return this.scopes.size
    }

    /** Claims are hashed (they may carry personal data); policies and claim-mapped roles read them, so they key the scope. */
    private DigestOf(context: AccessContext, version: string): string
    {
        const claims = [...context.Principal.Claims].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        const claimsHash = createHash(DevAccessScopeSource.HashAlgorithm).update(JSON.stringify(claims)).digest(DevAccessScopeSource.HexEncoding)
        return JSON.stringify([ConnectorPrincipalDigest.Of(context), context.Tenant.Id, claimsHash, version, this.generation])
    }

    private Drop(schema: boolean): void
    {
        this.scopes.clear()
        this.reported.clear()
        if (schema) this.schema = undefined
        this.dropped.Raise()
    }

    private async Compile(context: AccessContext, schema: SchemaState, digest: string): Promise<CompiledScope>
    {
        const policy = schema.Policies.Compile(new PrincipalFacts(context.Principal), AccessDefault.Allow)
        const messages = schema.Policies.Diagnostics.map(diagnostic => diagnostic.Message)
        let compiled: CompiledScope
        if (!this.identityConfigured)
        {
            compiled = new CompiledScope(AccessScope.Build({ Default: AccessDefault.Allow, Rows: policy.Rows }), digest, NoPlacementDefaults.Instance)
        }
        else
        {
            const evaluator = await this.readAuthorization!.EvaluatorForContext(context)
            const hasModel = await this.readAuthorization!.HasSecurityModelFor(context)
            const depth = DepthScopeCompiler.Compile(evaluator, context.Principal, schema.Description, hasModel)
            messages.push(...depth.Diagnostics.map(diagnostic => diagnostic.Message))
            compiled = new CompiledScope(AccessScopeConjunction.And(policy, depth.Scope(), schema.Catalog), digest, depth)
        }
        // the engine's own scope validation (ruling R63): a scope it would reject is never handed out
        const reader = await schema.Engine.BeginRead(compiled.Scope)
        reader.dispose()
        this.Report(messages)
        return compiled
    }

    private Report(messages: readonly string[]): void
    {
        const fresh = messages.filter(message => !this.reported.has(message))
        if (fresh.length === 0) return
        for (const message of fresh) this.reported.add(message)
        this.diagnostics.ScopeDiagnostics(fresh)
    }

    /** The engine and the snapshot it runs, read so the repository and description belong to the engine's version. */
    private async Schema(): Promise<SchemaState>
    {
        for (let attempt = 0; attempt < DevAccessScopeSource.MaxSnapshotReads; attempt++)
        {
            const engine = await this.host.Engine()
            if (this.schema !== undefined && this.schema.Engine === engine && this.schema.Version === engine.SchemaVersion) return this.schema
            const description = await this.host.Description()
            const repository = await this.host.Repository()
            if (description === await this.host.Description() && description.Version === engine.SchemaVersion)
            {
                this.schema = new SchemaState(engine, description, repository)
                return this.schema
            }
        }
        throw new DevAccessScopeError(DevAccessScopeErrorCode.SchemaUnsettled)
    }
}
