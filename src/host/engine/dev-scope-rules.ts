import { AccessDefault, AccessScope, GraphError, GraphErrorCode } from '@pragmatic-tech-ai/graph'
import type { CellValue, Cypher } from '@pragmatic-tech-ai/graph'
import { TodlNodePlacement } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { NoPlacementDefaults } from './access-scope-source.js'
import type { IPreparedRules, IScopeRecords, ITenantSecuritySource, ScopeSchema } from './access-scope-source.js'
import { DepthScopeCompiler } from './depth-scope-compiler.js'
import type { IPlacementDefaults } from './depth-scope-compiler.js'
import type { IDevGraphEngine } from './dev-graph-engine-host.js'
import type { DevSnapshot } from './dev-snapshot-source.js'
import { ExternalConcepts } from './external-concepts.js'
import { SavedMemberReader } from './saved-member-reader.js'
import { SecuredScopeRules } from './secured-scope-rules.js'

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

/** The dev rules against one schema: depth records (connector-bound concepts skipped), no finish, TODL placement. */
class DevPreparedRules implements IPreparedRules
{
    private static readonly MissingModelMessage = 'a dev create needs the model it is placed in'

    public constructor(
        private readonly schema: ScopeSchema,
        private readonly security: ITenantSecuritySource | undefined,
        private readonly external: ExternalConcepts,
        private readonly solutionName: string | undefined,
        public readonly Digest: string)
    {
    }

    public async Records(context: AccessContext): Promise<IScopeRecords>
    {
        // no identity subsystem: open dev reads and writes, nothing stamped
        if (this.security === undefined) return { Scope: AccessScope.Build({ Default: AccessDefault.Allow }), Diagnostics: [], Defaults: NoPlacementDefaults.Instance }
        const evaluator = await this.security.EvaluatorForContext(context)
        const hasModel = await this.security.HasSecurityModelFor(context)
        const depth = DepthScopeCompiler.Compile(evaluator, context.Principal, this.schema.Description, hasModel, { Skip: concept => this.external.Has(concept) })
        return { Scope: depth.Scope(), Diagnostics: depth.Diagnostics.map(diagnostic => diagnostic.Message), Defaults: depth }
    }

    public Finish(scope: AccessScope, _context: AccessContext): Promise<AccessScope>
    {
        return Promise.resolve(scope)
    }

    public Placement(defaults: IPlacementDefaults, modelId: string | undefined): Cypher.INodePlacement
    {
        if (modelId === undefined) throw new GraphError(GraphErrorCode.InvalidArgument, DevPreparedRules.MissingModelMessage)
        // a model id with no namespace prefix falls back to the solution name (as the dev draft does), else to itself
        const namespace = SavedMemberReader.NamespaceOf(modelId, this.solutionName ?? modelId)
        return new DevNodePlacement(new TodlNodePlacement(modelId, namespace), defaults)
    }
}

/**
 * The dev tenant's scope rules (AccessScopeSource), holding the dev identity state (amendment A2, ruling R13):
 *
 * - No identity subsystem: the record part is Default Allow with no rows and no write rules, nothing stamped.
 * - Identity configured: the record part is the tenant security model's access depth and field security alone
 *   (DepthScopeCompiler; tier 1 only, ruling A1; a tenant with no security model is deny-all), skipping every concept
 *   bound to an external binding of the snapshot's `Identity` and its subconcepts (ruling R6/R12: connector data is
 *   outside platform security; none on dev until its connectors are described).
 * - `Finish` is the identity; placement is TODL's (the model's namespace, the model as owner) stamped with the depth
 *   create defaults, and a create with no model is InvalidArgument.
 * - `Digest` is the security generation: `Invalidated` bumps it and raises `Changed`, so cached scopes and cursors
 *   minted before a security-model reload are superseded.
 *
 * Identity configured without a security source is refused at construction (AccessScopeError MissingSecuritySource).
 */
export class DevScopeRules extends SecuredScopeRules<DevSnapshot>
{
    public constructor(
        private readonly host: IDevGraphEngine,
        security: ITenantSecuritySource | undefined,
        identityConfigured: boolean,
        private readonly solutionName: () => Promise<string | undefined> = () => Promise.resolve(undefined))
    {
        super(security, identityConfigured)
    }

    public async Prepare(schema: ScopeSchema): Promise<IPreparedRules>
    {
        const snapshot = await this.SnapshotOf(schema)
        return new DevPreparedRules(schema, this.security, new ExternalConcepts(snapshot.Identity, schema.Catalog), await this.solutionName(), this.Generation)
    }

    protected Snapshot(): Promise<DevSnapshot>
    {
        return this.host.Snapshot()
    }
}
