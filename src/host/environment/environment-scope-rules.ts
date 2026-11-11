import { AccessDefault, AccessScope, Not, OwnerIs, Seeded } from '@pragmatic-tech-ai/graph'
import { FalsePredicate } from '@pragmatic-tech-ai/graph'
import type { CellValue, Cypher } from '@pragmatic-tech-ai/graph'
import { EnvironmentNodePlacement, SystemNames, TodlNames } from '@pragmatic-tech-ai/todl/engine'
import type { IEnvironmentCatalog, IPrincipalFacts } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import { NoPlacementDefaults } from '../engine/access-scope-source.js'
import type { IPreparedRules, IScopeRecords, ITenantSecuritySource, ScopeSchema } from '../engine/access-scope-source.js'
import { WriteRule } from '../engine/access-scope-conjunction.js'
import { DepthScopeCompiler } from '../engine/depth-scope-compiler.js'
import type { IPlacementDefaults } from '../engine/depth-scope-compiler.js'
import { ExternalConcepts } from '../engine/external-concepts.js'
import { SecuredScopeRules } from '../engine/secured-scope-rules.js'
import type { EnvironmentSnapshot } from './environment-engine-host.js'
import { ScopeDraft } from '../engine/scope-draft.js'
import { GrantWidening } from './grant-widening.js'

/** The environment snapshot the rules read (EnvironmentEngineHost). */
export interface IEnvironmentSnapshotSource
{
    Snapshot(): Promise<EnvironmentSnapshot>
}

/**
 * TODL environment placement (ruling S6): an external binding's create goes to its source, every other create is an
 * engine node owned by the concept's home package; its defaults (R112: the text id member left unset) are unioned
 * with the principal's depth create defaults (owner members; the two never share a member).
 */
class EnvironmentPlacement implements Cypher.INodePlacement
{
    public constructor(private readonly inner: EnvironmentNodePlacement, private readonly defaults: IPlacementDefaults)
    {
    }

    public Place(concept: string, properties: ReadonlyMap<string, CellValue>): Cypher.INodePlace
    {
        const place = this.inner.Place(concept, properties)
        const depth = this.defaults.Defaults(concept)
        if (depth.size === 0) return place
        return { ...place, Defaults: new Map<string, CellValue>([...(place.Defaults ?? []), ...depth]) }
    }
}

/** The runtime rules against one environment schema (EnvironmentScopeRules). */
class EnvironmentPreparedRules implements IPreparedRules
{
    /** A grant is linked by no caller scope, from it or to it (the tier-1 compiler's ShareGrant entry). */
    private static readonly GrantRules: readonly WriteRule[] = [WriteRule.Create, WriteRule.Update, WriteRule.Delete, WriteRule.Append, WriteRule.AppendTo]
    /** A read-only binding's rows are not written or linked from; linking to them stays open. */
    private static readonly WriteRules: readonly WriteRule[] = [WriteRule.Create, WriteRule.Update, WriteRule.Delete, WriteRule.Append]
    private static readonly SeedRules: readonly WriteRule[] = [WriteRule.Update, WriteRule.Delete, WriteRule.Append]
    private static readonly NoOwnedConcepts: ReadonlySet<string> = new Set<string>()
    private static readonly NoPrincipal: IPrincipalFacts = { Id: '', HomeBusinessUnitId: '' }

    /** The evaluator `Records` resolved for a context, reused by its `Finish` (AccessScopeSource calls both in turn). */
    private readonly evaluators = new WeakMap<AccessContext, AccessDepthEvaluator>()

    public constructor(
        private readonly schema: ScopeSchema,
        private readonly catalog: IEnvironmentCatalog,
        private readonly security: ITenantSecuritySource | undefined,
        private readonly external: ExternalConcepts,
        public readonly Digest: string)
    {
    }

    public async Records(context: AccessContext): Promise<IScopeRecords>
    {
        if (this.security === undefined) return { Scope: AccessScope.Build({ Default: AccessDefault.Allow }), Diagnostics: [], Defaults: NoPlacementDefaults.Instance }
        const evaluator = await this.security.EvaluatorForContext(context)
        this.evaluators.set(context, evaluator)
        const hasModel = await this.security.HasSecurityModelFor(context)
        const depth = DepthScopeCompiler.Compile(evaluator, context.Principal, this.schema.Description, hasModel, { Skip: concept => this.external.Has(concept) })
        return { Scope: depth.Scope(), Diagnostics: depth.Diagnostics.map(diagnostic => diagnostic.Message), Defaults: depth }
    }

    public async Finish(scope: AccessScope, context: AccessContext): Promise<AccessScope>
    {
        const draft = new ScopeDraft(scope, this.schema.Catalog)
        if (this.security !== undefined)
        {
            const evaluator = this.evaluators.get(context) ?? await this.security.EvaluatorForContext(context)
            const subjects = { PrincipalId: context.Principal.Id, Teams: evaluator.MembershipOf(context.Principal).teams }
            GrantWidening.Apply(draft, subjects, key => this.EngineStored(key))
        }
        // ruling R31: grants are written only by the share, assign and data-write service scopes, with or without identity
        if (this.schema.Catalog.IsConcept(SystemNames.ShareGrant))
        {
            for (const rule of EnvironmentPreparedRules.GrantRules) draft.SetRule(SystemNames.ShareGrant, rule, FalsePredicate.Instance)
        }
        // (c) a read-only binding's rows are never created, updated or deleted (the gate judges the row's owner)
        for (const binding of this.catalog.Identity.ReadOnly())
        {
            const guard = new Not(new OwnerIs(new Set([binding.Model])))
            for (const rule of EnvironmentPreparedRules.WriteRules) draft.AndRule(binding.Binding.Concept, rule, guard)
        }
        // (d) seeded nodes are read-only at runtime (spec section 6)
        if (this.schema.Catalog.IsConcept(TodlNames.Element))
        {
            const unseeded = new Not(new Seeded())
            for (const rule of EnvironmentPreparedRules.SeedRules) draft.AndRule(TodlNames.Element, rule, unseeded)
        }
        return draft.Build()
    }

    public Placement(defaults: IPlacementDefaults, _modelId: string | undefined): Cypher.INodePlacement
    {
        // ruling S6: the model a write is confined to does not decide where a create goes; owned-concept placement (C3,
        // TODL security S1) is not used yet: no concept is placed as owned, so the principal facts are never read and
        // the owner defaults stay the depth create defaults
        const placement = new EnvironmentNodePlacement(this.catalog.Identity, this.catalog.HomeModels, EnvironmentPreparedRules.NoOwnedConcepts, EnvironmentPreparedRules.NoPrincipal)
        return new EnvironmentPlacement(placement, defaults)
    }

    /**
     * True for a key the share widening reaches: a delivered package's own concept (built-ins such as `todl.Element`
     * and `todl.Term` have no home model), neither a system concept nor connector-bound (amendment A3).
     */
    private EngineStored(key: string): boolean
    {
        const home = this.catalog.HomeModels.get(key)
        return home !== undefined && home !== SystemNames.Model && !this.external.Has(key)
    }
}

/**
 * The runtime environment's scope rules (AccessScopeSource over the EnvironmentEngineHost; ruling S5 as amended by A3,
 * placement S6). Tier 2 is gone (A1): no policy file is read and no concept is exempt from depth.
 *
 * - Records: identity configured → the tenant security model's access depth and field security
 *   (DepthScopeCompiler), skipping every concept bound to an external binding of `catalog.Identity` and its
 *   subconcepts (connector data is outside platform security; R12: they get explicit allow entries); a tenant with no
 *   security model is deny-all for everything else. No identity → Default Allow, nothing stamped. Interim until
 *   security S4 Task 9 replaces DepthScopeCompiler with the tier-1 compiler.
 * - Finish, in order: (a)+(b) with identity only, GrantWidening (grants widen engine-stored concepts: a delivered
 *   package's own, never a built-in, system or connector-bound one; the caller sees its own grants); `Writes[ShareGrant]`
 *   Create / Update / Delete / Append / AppendTo False with or without identity (ruling R31); (c) for every read-only
 *   external binding, `Not(OwnerIs({binding model}))` ANDed into Create / Update / Delete / Append of its concept;
 *   (d) `Not(Seeded)` ANDed into the root `todl.Element` Update, Delete and Append (a link from a node needs what a SET
 *   on it needs, R129). (c) and (d) apply without identity too.
 * - Placement: TODL EnvironmentNodePlacement stamped with the depth create defaults; `modelId` is ignored (S6).
 * - Digest (the security generation), `Changed`, the security source guard and the snapshot read: SecuredScopeRules
 *   (the source itself drops on host `Changed`, an upgrade or reopen).
 */
export class EnvironmentScopeRules extends SecuredScopeRules<EnvironmentSnapshot>
{
    public constructor(private readonly host: IEnvironmentSnapshotSource, security: ITenantSecuritySource | undefined, identityConfigured: boolean)
    {
        super(security, identityConfigured)
    }

    public async Prepare(schema: ScopeSchema): Promise<IPreparedRules>
    {
        const catalog = (await this.SnapshotOf(schema)).Catalog
        return new EnvironmentPreparedRules(schema, catalog, this.security, new ExternalConcepts(catalog.Identity, schema.Catalog), this.Generation)
    }

    protected Snapshot(): Promise<EnvironmentSnapshot>
    {
        return this.host.Snapshot()
    }
}
