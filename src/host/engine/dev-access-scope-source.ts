import { AccessDefault, AccessScope } from '@pragmatic-tech-ai/graph'
import type { CellValue, Cypher, GraphEngine, ISchemaDescription, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import type { Repository } from '@pragmatic-tech-ai/todl'
import { PolicyScopeCompiler, TodlNodePlacement } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ConnectorPrincipalDigest } from '../connector-read-authorization.js'
import type { ITenantSecurity } from '../cypher/read-filter-source.js'
import { AccessScopeConjunction } from './access-scope-conjunction.js'
import { DepthScopeCompiler } from './depth-scope-compiler.js'
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
    /** Stable, secret-free fingerprint of the scope (principal digest and engine schema version), for cursors. */
    readonly Digest: string
}

/** The tenant security the scope source reads (TenantReadAuthorization): the cached model and its reload signal. */
export interface ITenantSecuritySource
{
    SecurityFor(context: AccessContext): Promise<ITenantSecurity>
    /** Raised after a tenant's security model is invalidated (reloaded on next use). */
    readonly Invalidated: ISignal<string>
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

/** A principal's compiled scope for one schema version (cached; placement is per call). */
class CompiledScope
{
    private static readonly NoDefaults: ReadonlyMap<string, CellValue> = new Map()

    public constructor(public readonly Scope: AccessScope, public readonly Digest: string, private readonly defaults: (concept: string) => ReadonlyMap<string, CellValue> = () => CompiledScope.NoDefaults)
    {
    }

    public Defaults(concept: string): ReadonlyMap<string, CellValue>
    {
        return this.defaults(concept)
    }
}

/** TODL placement (the model's namespace and the model as owner) plus the principal's create defaults. */
class DevNodePlacement implements Cypher.INodePlacement
{
    public constructor(private readonly inner: TodlNodePlacement, private readonly compiled: CompiledScope)
    {
    }

    public Place(concept: string, properties: ReadonlyMap<string, CellValue>): Cypher.INodePlace
    {
        const place = this.inner.Place(concept, properties)
        const defaults = this.compiled.Defaults(concept)
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
        return new DevNodePlacement(new TodlNodePlacement(modelId, namespace), this.compiled)
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
 * Scopes are cached per (tenant, principal digest, claims, engine schema version) and dropped when the security model
 * is invalidated (TenantReadAuthorization.Invalidated) or the engine upgrades (host Changed). Every compiled scope is
 * checked by the engine itself (a read opened under it) before it is handed out.
 */
export class DevAccessScopeSource implements IDisposable
{
    private static readonly MaxSnapshotReads = 5
    private static readonly UnsettledMessage = 'the dev graph engine kept upgrading while its access scope was compiled'
    private static readonly MissingSecurityMessage = 'identity is configured but no tenant security source was given'

    private readonly scopes = new Map<string, Promise<CompiledScope>>()
    private readonly subscriptions: ISubscription[] = []
    private schema: SchemaState | undefined

    public constructor(
        private readonly host: IDevGraphEngine,
        private readonly readAuthorization: ITenantSecuritySource | undefined,
        private readonly identityConfigured: boolean,
        private readonly solutionName: () => Promise<string | undefined> = () => Promise.resolve(undefined))
    {
        if (identityConfigured && readAuthorization === undefined) throw new Error(DevAccessScopeSource.MissingSecurityMessage)
        this.subscriptions.push(host.Changed.Subscribe(() => this.Drop(true)))
        if (readAuthorization !== undefined) this.subscriptions.push(readAuthorization.Invalidated.Subscribe(() => this.Drop(false)))
    }

    public async ScopeFor(context: AccessContext): Promise<IDevScope>
    {
        const schema = await this.Schema()
        const principal = ConnectorPrincipalDigest.Of(context)
        const claims = [...context.Principal.Claims].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        // claims are part of the key (policies and claim-mapped roles read them) but never of the Digest
        const key = JSON.stringify([context.Tenant.Id, principal, claims, schema.Version])
        let compiled = this.scopes.get(key)
        if (compiled === undefined)
        {
            const built = this.Compile(context, schema, JSON.stringify([principal, schema.Version]))
            compiled = built
            this.scopes.set(key, built)
            built.catch(() =>
            {
                if (this.scopes.get(key) === built) this.scopes.delete(key)
            })
        }
        return new DevScope(await compiled, await this.solutionName())
    }

    public dispose(): void
    {
        for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
        this.Drop(true)
    }

    private Drop(schema: boolean): void
    {
        this.scopes.clear()
        if (schema) this.schema = undefined
    }

    private async Compile(context: AccessContext, schema: SchemaState, digest: string): Promise<CompiledScope>
    {
        const policy = schema.Policies.Compile(new PrincipalFacts(context.Principal), AccessDefault.Allow)
        let compiled: CompiledScope
        if (!this.identityConfigured)
        {
            compiled = new CompiledScope(AccessScope.Build({ Default: AccessDefault.Allow, Rows: policy.Rows }), digest)
        }
        else
        {
            const security = await this.readAuthorization!.SecurityFor(context)
            const depth = DepthScopeCompiler.Compile(security, context.Principal, schema.Description)
            compiled = new CompiledScope(AccessScopeConjunction.And(policy, depth.Scope(), schema.Catalog), digest, concept => depth.Defaults(concept))
        }
        // the engine's own scope validation (ruling R63): a scope it would reject is never handed out
        const reader = await schema.Engine.BeginRead(compiled.Scope)
        reader.dispose()
        return compiled
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
        throw new Error(DevAccessScopeSource.UnsettledMessage)
    }
}
