import { AccessDefault, AccessScope, ConceptIs, FalsePredicate, In, IsNull, Not, Or, TruePredicate, ValueType } from '@pragmatic-tech-ai/graph'
import type { CellValue, IReadOnlyMembers, ISchemaDescription, IWriteRules, Predicate } from '@pragmatic-tech-ai/graph'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { AccessLevel, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { Principal } from '@pragmatic-tech-ai/todl-identity'
import type { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import { WriteRule } from './access-scope-conjunction.js'
import { EngineSchemaCatalog } from './engine-schema-catalog.js'

/** Why a depth rule compiled to a constant or was dropped. Append-only: never renumber or reuse a value. */
export enum DepthDiagnosticCode
{
    /** A User-level rule whose owner field is not a property of the concept in the engine schema: it compiles to False. */
    MissingOwnerField = 1,
    /** A User-level rule on a concept with no owner (no ownership rule or no owner source): it compiles to False. */
    NoOwner,
    /** A business-unit rule whose field is not a property of the concept in the engine schema: it compiles to False. */
    MissingBusinessUnitField,
    /** The security model governs a concept the engine schema does not define: it has no instances to scope. */
    UnknownConcept,
    /** A create default names a field that is not a property of the concept: it is not placed. */
    UnknownDefaultField,
    /** An owner or business-unit field the engine types as other than String: ids never equal its values, so it compiles to False. */
    NonStringOwnershipField,
}

export interface IDepthDiagnostic
{
    readonly Code: DepthDiagnosticCode
    readonly Concept: string
    readonly Message: string
}

/** The values a create of a concept is stamped with (placement defaults, ruling R91). */
export interface IPlacementDefaults
{
    Defaults(concept: string): ReadonlyMap<string, CellValue>
}

/** The access-depth axis of one principal's dev scope, before it is combined with the policy scope. */
export class DepthScope implements IPlacementDefaults
{
    private static readonly NoDefaults: ReadonlyMap<string, CellValue> = new Map()

    public constructor(
        public readonly Rows: ReadonlyMap<string, Predicate>,
        /** Create / Update / Delete per concept; read-only members are kept apart in {@link DepthScope.ReadOnlyExact}. */
        public readonly Writes: ReadonlyMap<string, IWriteRules>,
        /** Exact-concept hidden members (R94): never inherited by subconcepts, as today's exact-concept field mask. */
        public readonly HiddenExact: ReadonlyMap<string, ReadonlySet<string>>,
        /** Exact-concept read-only members per operation (R94), folded into Writes as `ReadOnlyExact`. */
        public readonly ReadOnlyExact: ReadonlyMap<string, IReadOnlyMembers>,
        private readonly defaults: ReadonlyMap<string, ReadonlyMap<string, CellValue>>,
        public readonly Diagnostics: readonly IDepthDiagnostic[])
    {
    }

    /** Always Deny: a node of a concept no entry covers (the reserved root itself) is not visible. */
    public get Default(): AccessDefault
    {
        return AccessDefault.Deny
    }

    /** The security model's create defaults for `concept` (owner, business unit), restricted to its engine properties. */
    public Defaults(concept: string): ReadonlyMap<string, CellValue>
    {
        return this.defaults.get(concept) ?? DepthScope.NoDefaults
    }

    /** The axis as an engine scope (ReadOnlyExact folded into Writes). */
    public Scope(): AccessScope
    {
        const writes = new Map<string, IWriteRules>(this.Writes)
        for (const [concept, members] of this.ReadOnlyExact)
        {
            writes.set(concept, { ...writes.get(concept), ReadOnlyExact: members })
        }
        return AccessScope.Build({ Default: this.Default, Rows: this.Rows, Writes: writes, HiddenExact: this.HiddenExact })
    }
}

/** One concept's secured members, sorted by what the principal may do with them. */
class FieldSets
{
    public readonly Hidden = new Set<string>()
    public readonly ReadOnlyCreate = new Set<string>()
    public readonly ReadOnlyUpdate = new Set<string>()
}

/**
 * Compiles the tenant security model's access depth and field security for one principal into engine scope terms,
 * reproducing today's `AccessDepthInstanceFilter` / `AccessDepthWriteInstanceGate` / field mask, which judge each
 * instance on its OWN concept's effective level, ownership rule and secured fields:
 *
 * - Every described concept K (but the reserved `todl.Element` root and `todl.Term`) gets a Rows entry and a
 *   Create / Update / Delete entry guarded as `Or(Not(ConceptIs K), rule)` (ruling R93), so it judges K's own
 *   instances only and never K's subconcepts. The rule is K's level: None → False, Organization → True, User → the
 *   owner is the principal or one of its teams, BusinessUnit → the owning unit is in the principal's reach (home unit
 *   plus its teams' units), BusinessUnitAndChildren → in the reach or under it. Ownership resolves as
 *   OwnershipResolver does: a fixed source is a constant; an unset, empty or unknown business-unit VALUE reads as the
 *   root unit; an unset owner owns nothing. A rule naming a field the engine schema lacks (or types as non-String)
 *   compiles to False with a diagnostic.
 * - A concept without a privilege is None, so denied: ungoverned concepts stay fail-closed, as today. A tenant with no
 *   security model (DenyAll evaluator) therefore denies every instance, and its taxonomy terms too (ruling F-b: its
 *   Term row is False). Under a security model taxonomy terms (`todl.Term`) stay readable, as today (they are
 *   schema-level and never passed the depth filter); they are never writable.
 * - Field security, exact-concept like today's mask (R94): a secured member the principal may not read is in
 *   `HiddenExact`; a readable one it may not write at create is in `ReadOnlyExact.Create`, at update in
 *   `ReadOnlyExact.Update` (R92). A member secured on a parent is never hidden or read-only on a subconcept that does
 *   not secure it. Writing a hidden member is refused (HiddenMember): write-only members are not supported.
 */
export class DepthScopeCompiler
{
    private static readonly MissingOwnerMessage = 'owner field "{0}" is not a property of "{1}"; its User-level access compiles to False'
    private static readonly NoOwnerMessage = '"{0}" has no owner source; its User-level access compiles to False'
    private static readonly MissingUnitMessage = 'business-unit field "{0}" is not a property of "{1}"; its business-unit access compiles to False'
    private static readonly NonStringMessage = 'ownership field "{0}" of "{1}" is not a String property; its access compiles to False'
    private static readonly UnknownConceptMessage = 'the security model governs "{0}", which the engine schema does not define'
    private static readonly UnknownDefaultMessage = 'create default "{0}" is not a property of "{1}"; it is not placed'
    private static readonly Placeholder = /\{(\d)\}/g
    private static readonly NoArgument = ''
    private static readonly Operations: readonly (readonly [WriteRule, PrivilegeAction])[] = [
        [WriteRule.Create, PrivilegeAction.Create],
        [WriteRule.Update, PrivilegeAction.Update],
        [WriteRule.Delete, PrivilegeAction.Delete],
    ]

    private readonly catalog: EngineSchemaCatalog
    private readonly diagnostics = new Map<string, IDepthDiagnostic>()
    private readonly owners: readonly string[]
    private readonly reach: ReadonlySet<string>
    private readonly reachAndBelow: ReadonlySet<string>
    private readonly units: readonly string[]

    private constructor(private readonly evaluator: AccessDepthEvaluator, private readonly principal: Principal, description: ISchemaDescription, private readonly hasSecurityModel: boolean)
    {
        this.catalog = new EngineSchemaCatalog(description)
        const membership = evaluator.MembershipOf(principal)
        this.owners = [...new Set([principal.Id, ...membership.teams])].filter(owner => owner.length > 0)
        this.reach = evaluator.ReachOf(principal)
        const hierarchy = evaluator.Model().Hierarchy()
        const below = new Set<string>(this.reach)
        for (const unit of this.reach)
        {
            for (const descendant of hierarchy.DescendantsOf(unit)) below.add(descendant)
        }
        this.reachAndBelow = below
        this.units = [hierarchy.RootId(), ...hierarchy.DescendantsOf(hierarchy.RootId())]
    }

    /** `hasSecurityModel`: false for a tenant with no security model (a DenyAll evaluator), which reads no terms either. */
    public static Compile(evaluator: AccessDepthEvaluator, principal: Principal, description: ISchemaDescription, hasSecurityModel: boolean): DepthScope
    {
        return new DepthScopeCompiler(evaluator, principal, description, hasSecurityModel).Run()
    }

    private Run(): DepthScope
    {
        for (const concept of this.evaluator.GovernedConcepts())
        {
            if (!this.catalog.IsConcept(concept)) this.Report(DepthDiagnosticCode.UnknownConcept, concept, DepthScopeCompiler.UnknownConceptMessage, concept)
        }
        const concepts = this.catalog.Concepts().filter(concept => concept !== TodlNames.Element && concept !== TodlNames.Term)
        const rows = new Map<string, Predicate>()
        const writes = new Map<string, IWriteRules>()
        for (const concept of concepts)
        {
            rows.set(concept, this.Guarded(concept, PrivilegeAction.Read))
            const rules: Partial<Record<WriteRule, Predicate>> = {}
            for (const [rule, action] of DepthScopeCompiler.Operations) rules[rule] = this.Guarded(concept, action)
            writes.set(concept, rules)
        }
        // ruling F-b: terms are readable under any security model, but a tenant with none (DenyAll) reads nothing
        if (this.catalog.IsConcept(TodlNames.Term)) rows.set(TodlNames.Term, this.hasSecurityModel ? TruePredicate.Instance : FalsePredicate.Instance)
        const hidden = new Map<string, ReadonlySet<string>>()
        const readOnly = new Map<string, IReadOnlyMembers>()
        this.FieldSecurity(concepts, hidden, readOnly)
        return new DepthScope(rows, writes, hidden, readOnly, this.CreateDefaults(concepts), [...this.diagnostics.values()])
    }

    /** `concept`'s own rule for `action`, constraining only instances whose own concept is `concept` (ruling R93). */
    private Guarded(concept: string, action: PrivilegeAction): Predicate
    {
        const rule = this.Encode(this.evaluator.EffectiveLevel(this.principal, action, concept), concept)
        if (rule === TruePredicate.Instance) return rule
        const other = new Not(new ConceptIs(concept))
        return rule === FalsePredicate.Instance ? other : new Or([other, rule])
    }

    private Encode(level: AccessLevel, concept: string): Predicate
    {
        switch (level)
        {
            case AccessLevel.Organization:
                return TruePredicate.Instance
            case AccessLevel.User:
                return this.OwnedBy(concept)
            case AccessLevel.BusinessUnit:
                return this.InUnits(concept, this.reach)
            case AccessLevel.BusinessUnitAndChildren:
                return this.InUnits(concept, this.reachAndBelow)
            default:
                return FalsePredicate.Instance
        }
    }

    /** The owner is the principal or one of its teams (OwnershipResolver: a fixed owner is a constant, an unset field owns nothing). */
    private OwnedBy(concept: string): Predicate
    {
        const ownership = this.evaluator.Model().Ownership()
        const field = ownership.OwnerField(concept)
        if (field === undefined)
        {
            const owner = ownership.Resolve(DepthScopeCompiler.EmptyView(concept)).owner
            if (owner === undefined)
            {
                this.Report(DepthDiagnosticCode.NoOwner, concept, DepthScopeCompiler.NoOwnerMessage, concept)
                return FalsePredicate.Instance
            }
            return DepthScopeCompiler.Bool(this.owners.includes(owner))
        }
        if (!this.StringProperty(concept, field, DepthDiagnosticCode.MissingOwnerField, DepthScopeCompiler.MissingOwnerMessage)) return FalsePredicate.Instance
        return new In(field, this.owners)
    }

    /**
     * The owning business unit is in `units` (OwnershipResolver: a fixed unit is a constant; an unset, empty or unknown
     * value of the declared field reads as the root unit). A field the engine schema lacks compiles to False.
     */
    private InUnits(concept: string, units: ReadonlySet<string>): Predicate
    {
        const ownership = this.evaluator.Model().Ownership()
        const root = this.evaluator.Model().Hierarchy().RootId()
        const field = ownership.BusinessUnitField(concept)
        if (field === undefined)
        {
            return DepthScopeCompiler.Bool(units.has(ownership.Resolve(DepthScopeCompiler.EmptyView(concept)).owningBusinessUnit))
        }
        if (!this.StringProperty(concept, field, DepthDiagnosticCode.MissingBusinessUnitField, DepthScopeCompiler.MissingUnitMessage)) return FalsePredicate.Instance
        if (this.units.every(unit => units.has(unit))) return TruePredicate.Instance
        const inUnits = new In(field, [...units])
        if (!units.has(root)) return inUnits
        return new Or([new IsNull(field), inUnits, new Not(new In(field, this.units))])
    }

    /** True iff `field` is a String property of `concept`; else reports why (missing, or another value type). */
    private StringProperty(concept: string, field: string, missing: DepthDiagnosticCode, missingMessage: string): boolean
    {
        const type = this.catalog.PropertyType(concept, field)
        if (type === undefined)
        {
            this.Report(missing, concept, missingMessage, field, concept)
            return false
        }
        if (type !== ValueType.String)
        {
            this.Report(DepthDiagnosticCode.NonStringOwnershipField, concept, DepthScopeCompiler.NonStringMessage, field, concept)
            return false
        }
        return true
    }

    private FieldSecurity(concepts: readonly string[], hidden: Map<string, ReadonlySet<string>>, readOnly: Map<string, IReadOnlyMembers>): void
    {
        const fields = this.evaluator.FieldSecurity()
        if (!fields.HasSecuredFields()) return
        for (const concept of concepts)
        {
            const sets = new FieldSets()
            for (const member of this.catalog.Members(concept))
            {
                if (!fields.IsSecured(concept, member)) continue
                if (!fields.CanReadField(this.principal, concept, member))
                {
                    sets.Hidden.add(member)
                    continue
                }
                if (!fields.CanWriteField(this.principal, concept, member, PrivilegeAction.Create)) sets.ReadOnlyCreate.add(member)
                if (!fields.CanWriteField(this.principal, concept, member, PrivilegeAction.Update)) sets.ReadOnlyUpdate.add(member)
            }
            if (sets.Hidden.size > 0) hidden.set(concept, sets.Hidden)
            if (sets.ReadOnlyCreate.size > 0 || sets.ReadOnlyUpdate.size > 0)
            {
                readOnly.set(concept, {
                    ...(sets.ReadOnlyCreate.size > 0 ? { Create: sets.ReadOnlyCreate } : {}),
                    ...(sets.ReadOnlyUpdate.size > 0 ? { Update: sets.ReadOnlyUpdate } : {}),
                })
            }
        }
    }

    private CreateDefaults(concepts: readonly string[]): ReadonlyMap<string, ReadonlyMap<string, CellValue>>
    {
        const out = new Map<string, ReadonlyMap<string, CellValue>>()
        for (const concept of concepts)
        {
            const values = new Map<string, CellValue>()
            for (const stamp of this.evaluator.CreateDefaults(this.principal, concept))
            {
                if (this.catalog.IsProperty(concept, stamp.field)) values.set(stamp.field, stamp.value)
                else this.Report(DepthDiagnosticCode.UnknownDefaultField, concept, DepthScopeCompiler.UnknownDefaultMessage, stamp.field, concept)
            }
            if (values.size > 0) out.set(concept, values)
        }
        return out
    }

    private Report(code: DepthDiagnosticCode, concept: string, template: string, ...args: string[]): void
    {
        const message = template.replace(DepthScopeCompiler.Placeholder, (_match, index: string) => args[Number(index)] ?? DepthScopeCompiler.NoArgument)
        this.diagnostics.set(message, { Code: code, Concept: concept, Message: message })
    }

    private static EmptyView(concept: string): { Concept: string; Field: (name: string) => undefined }
    {
        return { Concept: concept, Field: () => undefined }
    }

    private static Bool(value: boolean): Predicate
    {
        return value ? TruePredicate.Instance : FalsePredicate.Instance
    }
}
