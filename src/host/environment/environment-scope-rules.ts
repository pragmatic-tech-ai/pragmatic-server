import { AccessDefault, AccessScope, Not, OwnerIs, Seeded } from '@pragmatic-tech-ai/graph'
import type { CellValue, Cypher, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { EnvironmentNodePlacement, SystemNames, TodlNames } from '@pragmatic-tech-ai/todl/engine'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import { AccessScopeError, AccessScopeErrorCode, NoPlacementDefaults } from '../engine/access-scope-source.js'
import type { IPreparedRules, IScopeRecords, IScopeRules, ITenantSecuritySource, ScopeSchema } from '../engine/access-scope-source.js'
import { WriteRule } from '../engine/access-scope-conjunction.js'
import { DepthScopeCompiler } from '../engine/depth-scope-compiler.js'
import type { IPlacementDefaults } from '../engine/depth-scope-compiler.js'
import { ExternalConcepts } from '../engine/external-concepts.js'
import type { EnvironmentSnapshot } from './environment-engine-host.js'
import { ScopeDraft } from './scope-draft.js'
import { ShareWidening } from './share-widening.js'

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

/** The subscribe side of the rules' change signal (raised when the tenant security model is invalidated). */
class RulesChanged implements ISignal<void>
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

/** The runtime rules against one environment schema (EnvironmentScopeRules). */
class EnvironmentPreparedRules implements IPreparedRules
{
    private static readonly WriteRules: readonly WriteRule[] = [WriteRule.Create, WriteRule.Update, WriteRule.Delete]
    private static readonly SeedRules: readonly WriteRule[] = [WriteRule.Update, WriteRule.Delete]

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
        const hasModel = await this.security.HasSecurityModelFor(context)
        const depth = DepthScopeCompiler.Compile(evaluator, context.Principal, this.schema.Description, hasModel, { Skip: concept => this.external.Has(concept) })
        return { Scope: depth.Scope(), Diagnostics: depth.Diagnostics.map(diagnostic => diagnostic.Message), Defaults: depth }
    }

    public async Finish(scope: AccessScope, context: AccessContext): Promise<AccessScope>
    {
        const draft = new ScopeDraft(scope, this.schema.Catalog)
        if (this.security !== undefined)
        {
            const evaluator = await this.security.EvaluatorForContext(context)
            const subjects = { PrincipalId: context.Principal.Id, Teams: evaluator.MembershipOf(context.Principal).teams }
            ShareWidening.Apply(draft, subjects, key => this.EngineStored(key))
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
        // ruling S6: the model a write is confined to does not decide where a create goes
        return new EnvironmentPlacement(new EnvironmentNodePlacement(this.catalog.Identity, this.catalog.HomeModels), defaults)
    }

    /** True for a key the share widening reaches: neither a system concept nor connector-bound (amendment A3). */
    private EngineStored(key: string): boolean
    {
        return this.catalog.HomeModels.get(key) !== SystemNames.Model && !this.external.Has(key)
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
 * - Finish, in order: (a)+(b) with identity only, ShareWidening (grants widen engine-stored concepts; the caller sees
 *   its own grants and writes none); (c) for every read-only external binding, `Not(OwnerIs({binding model}))` ANDed
 *   into Create / Update / Delete of its concept; (d) `Not(Seeded)` ANDed into the root `todl.Element` Update and
 *   Delete. (c) and (d) apply without identity too.
 * - Placement: TODL EnvironmentNodePlacement stamped with the depth create defaults; `modelId` is ignored (S6).
 * - Digest: the security generation: `Invalidated` bumps it and raises `Changed`, so cached scopes and cursors minted
 *   before a security-model reload are superseded (the source itself drops on host `Changed`, an upgrade or reopen).
 *
 * Identity configured without a security source is refused at construction (AccessScopeError MissingSecuritySource).
 */
export class EnvironmentScopeRules implements IScopeRules
{
    private static readonly MaxSnapshotReads = 5

    public readonly Changed: ISignal<void>

    private readonly changed = new RulesChanged()
    private readonly security: ITenantSecuritySource | undefined
    private readonly subscription: ISubscription | undefined
    private generation = 0

    public constructor(private readonly host: IEnvironmentSnapshotSource, security: ITenantSecuritySource | undefined, identityConfigured: boolean)
    {
        this.Changed = this.changed
        if (identityConfigured && security === undefined) throw new AccessScopeError(AccessScopeErrorCode.MissingSecuritySource)
        this.security = identityConfigured ? security : undefined
        this.subscription = this.security?.Invalidated.Subscribe(() =>
        {
            this.generation += 1
            this.changed.Raise()
        })
    }

    public async Prepare(schema: ScopeSchema): Promise<IPreparedRules>
    {
        const snapshot = await this.SnapshotOf(schema)
        const catalog = snapshot.Catalog
        return new EnvironmentPreparedRules(schema, catalog, this.security, new ExternalConcepts(catalog.Identity, schema.Catalog), String(this.generation))
    }

    public dispose(): void
    {
        this.subscription?.dispose()
    }

    /** The snapshot of `schema`'s version, so its catalog and the schema agree; an upgrade racing it is re-read. */
    private async SnapshotOf(schema: ScopeSchema): Promise<EnvironmentSnapshot>
    {
        for (let attempt = 0; attempt < EnvironmentScopeRules.MaxSnapshotReads; attempt++)
        {
            const snapshot = await this.host.Snapshot()
            if (snapshot.Description.Version === schema.Version) return snapshot
            await EnvironmentScopeRules.Yield()
        }
        throw new AccessScopeError(AccessScopeErrorCode.SchemaUnsettled)
    }

    private static Yield(): Promise<void>
    {
        return new Promise<void>(resolve => setImmediate(resolve))
    }
}
