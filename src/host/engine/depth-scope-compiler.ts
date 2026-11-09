import { AccessDefault, AccessScope, FalsePredicate, In, IsNull, Not, Or, TruePredicate } from '@pragmatic-tech-ai/graph'
import type { CellValue, ISchemaDescription, IWriteRules, Predicate } from '@pragmatic-tech-ai/graph'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { AccessLevel, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { Principal } from '@pragmatic-tech-ai/todl-identity'
import type { ITenantSecurity } from '../cypher/read-filter-source.js'
import { WriteRule } from './access-scope-conjunction.js'
import { EngineSchemaCatalog } from './engine-schema-catalog.js'

/** Why a depth rule compiled to a constant or was dropped. Append-only: never renumber or reuse a value. */
export enum DepthDiagnosticCode
{
    /** A User-level rule whose owner field is not a property of the concept in the engine schema: it compiles to False. */
    MissingOwnerField = 1,
    /** A User-level rule on a concept with no owner (no ownership rule or no owner source): it compiles to False. */
    NoOwner,
    /** A business-unit rule whose field is not a property of the concept: every instance reads as owned by the root unit. */
    MissingBusinessUnitField,
    /** The security model governs a concept the engine schema does not define: it has no instances to scope. */
    UnknownConcept,
    /** A create default names a field that is not a property of the concept: it is not placed. */
    UnknownDefaultField,
}

export interface IDepthDiagnostic
{
    readonly Code: DepthDiagnosticCode
    readonly Concept: string
    readonly Message: string
}

/** The access-depth axis of one principal's dev scope, before it is combined with the policy scope. */
export class DepthScope
{
    private static readonly NoDefaults: ReadonlyMap<string, CellValue> = new Map()

    public constructor(
        public readonly Default: AccessDefault,
        public readonly Rows: ReadonlyMap<string, Predicate>,
        /** Create / Update / Delete per concept; ReadOnly is kept apart in {@link DepthScope.ReadOnly}. */
        public readonly Writes: ReadonlyMap<string, IWriteRules>,
        public readonly Hidden: ReadonlyMap<string, ReadonlySet<string>>,
        public readonly ReadOnly: ReadonlyMap<string, ReadonlySet<string>>,
        private readonly defaults: ReadonlyMap<string, ReadonlyMap<string, CellValue>>,
        public readonly Diagnostics: readonly IDepthDiagnostic[])
    {
    }

    /** The values a create of `concept` is stamped with (the security model's create defaults: owner, business unit). */
    public Defaults(concept: string): ReadonlyMap<string, CellValue>
    {
        return this.defaults.get(concept) ?? DepthScope.NoDefaults
    }

    /** The axis as an engine scope (ReadOnly folded into Writes). */
    public Scope(): AccessScope
    {
        const writes = new Map<string, IWriteRules>(this.Writes)
        for (const [concept, members] of this.ReadOnly)
        {
            writes.set(concept, { ...writes.get(concept), ReadOnly: members })
        }
        return AccessScope.Build({ Default: this.Default, Rows: this.Rows, Writes: writes, Hidden: this.Hidden })
    }
}

/**
 * Compiles the tenant security model's access depth and field security for one principal into engine scope terms,
 * mirroring today's `AccessDepthInstanceFilter` / `AccessDepthWriteInstanceGate` / field mask, which decide per
 * instance on its exact concept:
 *
 * - Each concept's effective level per action (Read → Rows; Create / Update / Delete → Writes): None → False,
 *   Organization → True, User → the owner is the principal or one of its teams, BusinessUnit → the owning unit is in
 *   the principal's reach (home unit plus its teams' units), BusinessUnitAndChildren → the owning unit is in the reach
 *   or under it. Ownership resolves as OwnershipResolver does: a fixed source is a constant, an unset, empty or unknown
 *   business-unit field reads as the root unit, an unset owner field owns nothing.
 * - A concept without a privilege is denied (Default Deny): ungoverned concepts stay fail-closed, as today.
 * - The engine applies a Rows / Writes entry to the key's descendants too (today's evaluator does not). A None concept
 *   therefore gets an explicit False only when an ancestor's entry would otherwise admit it; a concept is never wider
 *   than an ancestor's entry (fail-closed where the two models differ).
 * - Field security: a secured member the principal may not read is Hidden; a readable one it may not write at create
 *   or at update is ReadOnly (the engine has one read-only set for both).
 * - No security model: deny all (False on `todl.Element`, every write False), today's DenyAll.
 * - Taxonomy terms (`todl.Term`) stay readable: today they are schema-level and never pass the depth filter.
 */
export class DepthScopeCompiler
{
    private static readonly MissingOwnerMessage = 'owner field "{0}" is not a property of "{1}"; its User-level access compiles to False'
    private static readonly NoOwnerMessage = '"{0}" has no owner source; its User-level access compiles to False'
    private static readonly MissingUnitMessage = 'business-unit field "{0}" is not a property of "{1}"; every instance reads as owned by the root unit'
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

    private constructor(private readonly security: ITenantSecurity, private readonly principal: Principal, description: ISchemaDescription)
    {
        this.catalog = new EngineSchemaCatalog(description)
        const membership = security.Evaluator.MembershipOf(principal)
        this.owners = [...new Set([principal.Id, ...membership.teams])].filter(owner => owner.length > 0)
        const reach = new Set<string>([membership.homeBusinessUnit])
        for (const team of membership.teams)
        {
            const unit = security.TeamBusinessUnits.get(team)
            if (unit !== undefined) reach.add(unit)
        }
        this.reach = reach
        const hierarchy = security.Model.Hierarchy()
        const below = new Set<string>(reach)
        for (const unit of reach)
        {
            for (const descendant of hierarchy.DescendantsOf(unit)) below.add(descendant)
        }
        this.reachAndBelow = below
        this.units = [hierarchy.RootId(), ...hierarchy.DescendantsOf(hierarchy.RootId())]
    }

    public static Compile(security: ITenantSecurity, principal: Principal, description: ISchemaDescription): DepthScope
    {
        return new DepthScopeCompiler(security, principal, description).Run()
    }

    private Run(): DepthScope
    {
        if (!this.security.HasSecurityModel) return DepthScopeCompiler.DenyAll()
        for (const concept of this.security.Evaluator.GovernedConcepts())
        {
            if (!this.catalog.IsConcept(concept)) this.Report(DepthDiagnosticCode.UnknownConcept, concept, DepthScopeCompiler.UnknownConceptMessage, concept)
        }
        const concepts = this.catalog.Concepts().filter(concept => concept !== TodlNames.Element && concept !== TodlNames.Term)
        const rows = new Map(this.Axis(concepts, PrivilegeAction.Read))
        if (this.catalog.IsConcept(TodlNames.Term)) rows.set(TodlNames.Term, TruePredicate.Instance)
        const writes = new Map<string, IWriteRules>()
        for (const [rule, action] of DepthScopeCompiler.Operations)
        {
            for (const [concept, predicate] of this.Axis(concepts, action))
            {
                writes.set(concept, { ...writes.get(concept), [rule]: predicate })
            }
        }
        const hidden = new Map<string, Set<string>>()
        const readOnly = new Map<string, Set<string>>()
        this.FieldSecurity(hidden, readOnly)
        return new DepthScope(AccessDefault.Deny, rows, writes, hidden, readOnly, this.CreateDefaults(concepts), [...this.diagnostics.values()])
    }

    private static DenyAll(): DepthScope
    {
        const none = FalsePredicate.Instance
        return new DepthScope(AccessDefault.Deny, new Map([[TodlNames.Element, none]]), new Map([[TodlNames.Element, { Create: none, Update: none, Delete: none }]]), new Map(), new Map(), new Map(), [])
    }

    /**
     * One action's entries: each concept's own level; a None concept is left to the Default Deny unless an ancestor's
     * entry would admit it, then it gets an explicit False.
     */
    private Axis(concepts: readonly string[], action: PrivilegeAction): ReadonlyMap<string, Predicate>
    {
        const desired = new Map<string, Predicate>()
        for (const concept of concepts)
        {
            desired.set(concept, this.Encode(this.security.Evaluator.EffectiveLevel(this.principal, action, concept), concept))
        }
        const out = new Map<string, Predicate>()
        for (const [concept, predicate] of desired)
        {
            if (predicate !== FalsePredicate.Instance) out.set(concept, predicate)
        }
        for (const [concept, predicate] of desired)
        {
            if (predicate === FalsePredicate.Instance && this.catalog.Ancestors(concept).some(ancestor => out.has(ancestor)))
            {
                out.set(concept, predicate)
            }
        }
        return out
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
        const ownership = this.security.Model.Ownership()
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
        if (!this.catalog.IsProperty(concept, field))
        {
            this.Report(DepthDiagnosticCode.MissingOwnerField, concept, DepthScopeCompiler.MissingOwnerMessage, field, concept)
            return FalsePredicate.Instance
        }
        return new In(field, this.owners)
    }

    /**
     * The owning business unit is in `units` (OwnershipResolver: a fixed unit is a constant; an unset, empty or unknown
     * field value reads as the root unit).
     */
    private InUnits(concept: string, units: ReadonlySet<string>): Predicate
    {
        const ownership = this.security.Model.Ownership()
        const root = this.security.Model.Hierarchy().RootId()
        const field = ownership.BusinessUnitField(concept)
        if (field === undefined)
        {
            return DepthScopeCompiler.Bool(units.has(ownership.Resolve(DepthScopeCompiler.EmptyView(concept)).owningBusinessUnit))
        }
        if (!this.catalog.IsProperty(concept, field))
        {
            this.Report(DepthDiagnosticCode.MissingBusinessUnitField, concept, DepthScopeCompiler.MissingUnitMessage, field, concept)
            return DepthScopeCompiler.Bool(units.has(root))
        }
        if (this.units.every(unit => units.has(unit))) return TruePredicate.Instance
        const inUnits = new In(field, [...units])
        if (!units.has(root)) return inUnits
        return new Or([new IsNull(field), inUnits, new Not(new In(field, this.units))])
    }

    private FieldSecurity(hidden: Map<string, Set<string>>, readOnly: Map<string, Set<string>>): void
    {
        const fields = this.security.Evaluator.FieldSecurity()
        if (!fields.HasSecuredFields()) return
        for (const concept of this.catalog.Concepts())
        {
            for (const member of this.catalog.Members(concept))
            {
                if (!fields.IsSecured(concept, member)) continue
                let target: Map<string, Set<string>> | undefined
                if (!fields.CanReadField(this.principal, concept, member))
                {
                    target = hidden
                }
                else if (!fields.CanWriteField(this.principal, concept, member, PrivilegeAction.Create) || !fields.CanWriteField(this.principal, concept, member, PrivilegeAction.Update))
                {
                    target = readOnly
                }
                if (target === undefined) continue
                const members = target.get(concept) ?? new Set<string>()
                members.add(member)
                target.set(concept, members)
            }
        }
    }

    private CreateDefaults(concepts: readonly string[]): ReadonlyMap<string, ReadonlyMap<string, CellValue>>
    {
        const out = new Map<string, ReadonlyMap<string, CellValue>>()
        for (const concept of concepts)
        {
            const values = new Map<string, CellValue>()
            for (const stamp of this.security.Evaluator.CreateDefaults(this.principal, concept))
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
