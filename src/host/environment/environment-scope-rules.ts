import { AccessDefault, AccessScope, FalsePredicate, Not, OwnerIs, Seeded } from '@pragmatic-tech-ai/graph'
import type { Cypher, ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { EnvironmentNodePlacement, SystemFieldGuard, SystemNames, TodlNames } from '@pragmatic-tech-ai/todl/engine'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { Tier1ScopeCompiler } from '@pragmatic-tech-ai/todl-identity-engine'
import type { TenantSecurityModel, Tier1Grants } from '@pragmatic-tech-ai/todl-identity-engine'
import { AccessScopeError, AccessScopeErrorCode, VoidSignal } from '../engine/access-scope-source.js'
import type { IPreparedRules, IScopeRecords, IScopeRules, ScopeSchema } from '../engine/access-scope-source.js'
import { WriteRule } from '../engine/access-scope-conjunction.js'
import type { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { PrincipalFacts } from '../engine/principal-facts.js'
import { ScopeDraft } from '../engine/scope-draft.js'
import type { EnvironmentSnapshot } from './environment-engine-host.js'
import type { EnvironmentSecuritySetting } from './environment-security-setting.js'

/** The environment host as the rules read it: its snapshot and its upgrade signal. */
export interface IEnvironmentSnapshotSource
{
    Snapshot(): Promise<EnvironmentSnapshot>
    readonly Changed: ISignal<void>
}

/**
 * The tier-1 decisions an AccessScope cannot carry, for the share and assign services (EnvironmentScopeRules): the
 * setting's model, the caller's grants (share / assign coverage) and the assign base scope, all against one snapshot.
 */
export interface IEnvironmentTier1
{
    /** The environment setting's model (fail closed, EnvironmentSecuritySetting). */
    Model(): Promise<TenantSecurityModel>
    /** The caller's tier-1 grants over `snapshot`'s packages. */
    Grants(context: AccessContext, snapshot: EnvironmentSnapshot): Promise<Tier1Grants>
    /**
     * The assign service's base scope (PR2): `Tier1ScopeCompiler.CompileAssign`, NOT under SystemFieldGuard (the system
     * fields are writable there), with the runtime Finish steps applied (grants, read-only bindings, seeded nodes).
     */
    AssignRecords(context: AccessContext, snapshot: EnvironmentSnapshot): Promise<AccessScope>
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
    private static readonly Unrestricted: IScopeRecords = { Scope: AccessScope.Build({ Default: AccessDefault.Allow }), Diagnostics: [], Principal: PrincipalFacts.None }

    public constructor(
        private readonly schema: EngineSchemaCatalog,
        private readonly catalog: IEnvironmentCatalog,
        private readonly setting: EnvironmentSecuritySetting | undefined,
        public readonly Digest: string)
    {
    }

    public async Records(context: AccessContext): Promise<IScopeRecords>
    {
        if (this.setting === undefined) return EnvironmentPreparedRules.Unrestricted
        const model = await this.setting.Model()
        // PR1: the system-field guard applies to every runtime scope, the System Administrator's included
        const scope = SystemFieldGuard.Guard(Tier1ScopeCompiler.Compile(context.Principal, this.catalog.Security, model, this.catalog))
        const diagnostics = Tier1ScopeCompiler.Diagnose(this.catalog.Security, model, this.catalog).map(diagnostic => diagnostic.Message)
        return { Scope: scope, Diagnostics: diagnostics, Principal: PrincipalFacts.For(context.Principal, model) }
    }

    public Finish(scope: AccessScope, _context: AccessContext): Promise<AccessScope>
    {
        const draft = new ScopeDraft(scope, this.schema)
        // ruling R31: grants are written only by the share, assign and data-write service scopes, with or without identity
        if (this.schema.IsConcept(SystemNames.ShareGrant))
        {
            for (const rule of EnvironmentPreparedRules.GrantRules) draft.SetRule(SystemNames.ShareGrant, rule, FalsePredicate.Instance)
        }
        // a read-only binding's rows are never created, updated or deleted (the gate judges the row's owner)
        for (const binding of this.catalog.Identity.ReadOnly())
        {
            const guard = new Not(new OwnerIs(new Set([binding.Model])))
            for (const rule of EnvironmentPreparedRules.WriteRules) draft.AndRule(binding.Binding.Concept, rule, guard)
        }
        // seeded nodes are read-only at runtime (spec section 6)
        if (this.schema.IsConcept(TodlNames.Element))
        {
            const unseeded = new Not(new Seeded())
            for (const rule of EnvironmentPreparedRules.SeedRules) draft.AndRule(TodlNames.Element, rule, unseeded)
        }
        return Promise.resolve(draft.Build())
    }

    /** Ruling S6 and C3: TODL's environment placement; an owned concept is stamped with the acting principal's facts. */
    public Placement(principal: PrincipalFacts, _modelId: string | undefined): Cypher.INodePlacement
    {
        const owned = this.setting === undefined ? EnvironmentPreparedRules.NoOwnedConcepts : this.catalog.Security.OwnedConcepts()
        return new EnvironmentNodePlacement(this.catalog.Identity, this.catalog.HomeModels, owned, principal)
    }
}

/**
 * The runtime environment's scope rules (AccessScopeSource over the EnvironmentEngineHost; ruling S5 as amended by A3,
 * placement S6, security S4 Task 9).
 *
 * - Records: identity configured → `SystemFieldGuard.Guard(Tier1ScopeCompiler.Compile(principal, catalog.Security,
 *   setting model, catalog))` (contract C6 over the C5 setting; PR1: the guard applies to the System Administrator's
 *   scope too). Tier 1 compiles the depth per role source (PR5), the share widening (R3), field security (Hidden),
 *   Append / AppendTo (PR3), edge concepts as Endpoints (PR4) and the platform vocabulary (PR6); connector concepts get
 *   no entries (spec §6) and fall to its Default Allow. No setting stored, or one that cannot be read, is the empty
 *   model: nobody holds a role. No identity → `AccessScope.Build({ Default: Allow })`, nothing stamped.
 * - Finish, with or without identity: `Writes[ShareGrant]` Create / Update / Delete / Append / AppendTo False (R31); for
 *   every read-only external binding `Not(OwnerIs({binding model}))` ANDed into Create / Update / Delete / Append of its
 *   concept; `Not(Seeded)` ANDed into the root `todl.Element` Update, Delete and Append.
 * - Placement: TODL EnvironmentNodePlacement; with identity an owned concept's create is stamped with the principal's
 *   id and home business unit (C3, PrincipalFacts); `modelId` is ignored (S6).
 * - Digest: JSON of `[setting generation, catalog package refs]`; `Changed` is raised on the host's Changed and the
 *   setting's Changed, so a setting edit stales every cached scope and cursor.
 */
export class EnvironmentScopeRules implements IScopeRules, IEnvironmentTier1
{
    private static readonly MaxSnapshotReads = 5

    public readonly Changed: ISignal<void>

    private readonly changed = new VoidSignal()
    private readonly subscriptions: ISubscription[] = []

    public constructor(private readonly host: IEnvironmentSnapshotSource, private readonly setting: EnvironmentSecuritySetting | undefined)
    {
        this.Changed = this.changed
        this.subscriptions.push(host.Changed.Subscribe(() => this.changed.Raise()))
        if (setting !== undefined) this.subscriptions.push(setting.Changed.Subscribe(() => this.changed.Raise()))
    }

    public async Prepare(schema: ScopeSchema): Promise<IPreparedRules>
    {
        const catalog = (await this.SnapshotOf(schema)).Catalog
        return new EnvironmentPreparedRules(schema.Catalog, catalog, this.setting, JSON.stringify([this.setting?.Generation ?? 0, catalog.Packages]))
    }

    public Model(): Promise<TenantSecurityModel>
    {
        return this.Setting().Model()
    }

    public async Grants(context: AccessContext, snapshot: EnvironmentSnapshot): Promise<Tier1Grants>
    {
        const catalog = snapshot.Catalog
        return Tier1ScopeCompiler.Grants(context.Principal, catalog.Security, await this.Model(), catalog)
    }

    public async AssignRecords(context: AccessContext, snapshot: EnvironmentSnapshot): Promise<AccessScope>
    {
        const catalog = snapshot.Catalog
        const scope = Tier1ScopeCompiler.CompileAssign(context.Principal, catalog.Security, await this.Model(), catalog)
        return new EnvironmentPreparedRules(snapshot.SchemaCatalog, catalog, this.setting, String(this.setting?.Generation ?? 0)).Finish(scope, context)
    }

    public dispose(): void
    {
        for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
    }

    private Setting(): EnvironmentSecuritySetting
    {
        if (this.setting === undefined) throw new AccessScopeError(AccessScopeErrorCode.NoSecuritySetting)
        return this.setting
    }

    /** The snapshot of `schema`'s version, so its catalog and the schema agree; an upgrade racing it is re-read. */
    private async SnapshotOf(schema: ScopeSchema): Promise<EnvironmentSnapshot>
    {
        for (let attempt = 0; attempt < EnvironmentScopeRules.MaxSnapshotReads; attempt++)
        {
            const snapshot = await this.host.Snapshot()
            if (snapshot.Description.Version === schema.Version) return snapshot
            await new Promise<void>(resolve => setImmediate(resolve))
        }
        throw new AccessScopeError(AccessScopeErrorCode.SchemaUnsettled)
    }
}
