import { AccessDefault, AccessScope, And, ConceptIs, FalsePredicate, Not, TruePredicate } from '@pragmatic-tech-ai/graph'
import type { IEndpointMembers, IReadOnlyMembers, IWriteRules, Predicate } from '@pragmatic-tech-ai/graph'
import type { EngineSchemaCatalog } from './engine-schema-catalog.js'

/** Folds conjunctions so a constant never leaves a needless tree (True is the identity, False absorbs). */
export class PredicateFold
{
    public static And(left: Predicate | undefined, right: Predicate): Predicate
    {
        if (left === undefined || left === TruePredicate.Instance) return right
        if (right === TruePredicate.Instance) return left
        if (left === FalsePredicate.Instance || right === FalsePredicate.Instance) return FalsePredicate.Instance
        return new And([...PredicateFold.Terms(left), ...PredicateFold.Terms(right)])
    }

    private static Terms(p: Predicate): readonly Predicate[]
    {
        return p instanceof And ? p.Terms : [p]
    }
}

/** The predicate-bearing members of IWriteRules, one per write operation the engine gates. */
export enum WriteRule
{
    Create = 'Create',
    Update = 'Update',
    Delete = 'Delete',
    /** Link / Unlink on the edge's source (engine security S2, R129). */
    Append = 'Append',
    /** Link / Unlink on the edge's target (engine security S2, R129). */
    AppendTo = 'AppendTo',
}

/** The per-operation read-only members of one key, unioned across scopes. */
class ReadOnlyDraft
{
    private create: Set<string> | undefined
    private update: Set<string> | undefined

    public Add(members: IReadOnlyMembers | undefined): void
    {
        for (const member of members?.Create ?? []) (this.create ??= new Set<string>()).add(member)
        for (const member of members?.Update ?? []) (this.update ??= new Set<string>()).add(member)
    }

    /** undefined when nothing is read-only. */
    public Members(): IReadOnlyMembers | undefined
    {
        if (this.create === undefined && this.update === undefined) return undefined
        return {
            ...(this.create === undefined ? {} : { Create: this.create }),
            ...(this.update === undefined ? {} : { Update: this.update }),
        }
    }
}

/** One key's write rules while two scopes are combined. */
class WriteRulesDraft
{
    public readonly Predicates = new Map<WriteRule, Predicate>()
    private readonly readOnly = new ReadOnlyDraft()
    private readonly readOnlyExact = new ReadOnlyDraft()

    public Add(rules: IWriteRules): void
    {
        for (const rule of AccessScopeConjunction.Rules)
        {
            const predicate = rules[rule]
            if (predicate !== undefined) this.And(rule, predicate)
        }
        this.readOnly.Add(rules.ReadOnly)
        this.readOnlyExact.Add(rules.ReadOnlyExact)
    }

    public And(rule: WriteRule, predicate: Predicate): void
    {
        this.Predicates.set(rule, PredicateFold.And(this.Predicates.get(rule), predicate))
    }

    public Rules(): IWriteRules
    {
        const readOnly = this.readOnly.Members()
        const readOnlyExact = this.readOnlyExact.Members()
        return {
            Create: this.Predicates.get(WriteRule.Create),
            Update: this.Predicates.get(WriteRule.Update),
            Delete: this.Predicates.get(WriteRule.Delete),
            Append: this.Predicates.get(WriteRule.Append),
            AppendTo: this.Predicates.get(WriteRule.AppendTo),
            ...(readOnly === undefined ? {} : { ReadOnly: readOnly }),
            ...(readOnlyExact === undefined ? {} : { ReadOnlyExact: readOnlyExact }),
        }
    }
}

/**
 * The AND of two access scopes over one engine schema, deny-wins: a node is visible (a write allowed) iff both scopes
 * admit it. Rows on the same key are ANDed, write rules are ANDed per operation, Hidden / HiddenExact and ReadOnly /
 * ReadOnlyExact (per operation) are unioned key by key (inherited sets stay inherited, exact sets exact), the
 * Endpoints are the union of both scopes' entries (two entries for one edge concept with different members throw: a host
 * bug, never a narrowing), and
 * the Default is Allow only when both are.
 *
 * A scope's Default only decides a node none of whose keys has an entry in that scope, but the combined scope sees
 * both scopes' entries. So where one scope would leave a concept to its Default Deny while the other has an entry
 * for it, the combined scope keeps the deny for that concept's OWN instances: `Not(ConceptIs concept)` is ANDed onto
 * its entry (per operation for writes). Never a plain False, which would also deny every subconcept (ruling R93).
 */
export class AccessScopeConjunction
{
    private static readonly ConflictingEndpointsMessage = 'the conjoined scopes give different endpoints to edge concept '

    public static readonly Rules: readonly WriteRule[] = [WriteRule.Create, WriteRule.Update, WriteRule.Delete, WriteRule.Append, WriteRule.AppendTo]

    public static And(left: AccessScope, right: AccessScope, catalog: EngineSchemaCatalog): AccessScope
    {
        const rows = new Map<string, Predicate>()
        const writes = new Map<string, WriteRulesDraft>()
        const hidden = new Map<string, Set<string>>()
        const hiddenExact = new Map<string, Set<string>>()
        const endpoints = new Map<string, IEndpointMembers>()
        for (const scope of [left, right])
        {
            for (const [key, members] of scope.Endpoints) AccessScopeConjunction.Endpoint(endpoints, key, members)
            for (const [key, predicate] of scope.Rows) rows.set(key, PredicateFold.And(rows.get(key), predicate))
            for (const [key, rules] of scope.Writes) AccessScopeConjunction.Draft(writes, key).Add(rules)
            AccessScopeConjunction.Union(hidden, scope.Hidden)
            AccessScopeConjunction.Union(hiddenExact, scope.HiddenExact)
        }
        for (const concept of catalog.Concepts())
        {
            const keys = catalog.Applicable(concept)
            const own = new Not(new ConceptIs(concept))
            for (const [self, other] of [[left, right], [right, left]] as const)
            {
                if (self.Default !== AccessDefault.Deny) continue
                if (!AccessScopeConjunction.HasRow(self, keys) && AccessScopeConjunction.HasRow(other, keys)) rows.set(concept, PredicateFold.And(rows.get(concept), own))
                for (const rule of AccessScopeConjunction.Rules)
                {
                    if (!AccessScopeConjunction.HasRule(self, keys, rule) && AccessScopeConjunction.HasRule(other, keys, rule))
                    {
                        AccessScopeConjunction.Draft(writes, concept).And(rule, own)
                    }
                }
            }
        }
        const fallback = left.Default === AccessDefault.Allow && right.Default === AccessDefault.Allow ? AccessDefault.Allow : AccessDefault.Deny
        const rules = new Map<string, IWriteRules>()
        for (const [key, draft] of writes) rules.set(key, draft.Rules())
        return AccessScope.Build({ Default: fallback, Rows: rows, Writes: rules, Hidden: hidden, HiddenExact: hiddenExact, Endpoints: endpoints })
    }

    /** Keeps one entry per edge concept; two different endpoint pairs for one concept are a host bug, never a narrowing. */
    private static Endpoint(into: Map<string, IEndpointMembers>, key: string, members: IEndpointMembers): void
    {
        const existing = into.get(key)
        if (existing !== undefined && (existing.From !== members.From || existing.To !== members.To))
        {
            throw new Error(AccessScopeConjunction.ConflictingEndpointsMessage + key)
        }
        into.set(key, members)
    }

    private static Union(into: Map<string, Set<string>>, from: ReadonlyMap<string, ReadonlySet<string>>): void
    {
        for (const [key, members] of from)
        {
            const union = into.get(key) ?? new Set<string>()
            for (const member of members) union.add(member)
            into.set(key, union)
        }
    }

    private static Draft(writes: Map<string, WriteRulesDraft>, key: string): WriteRulesDraft
    {
        let draft = writes.get(key)
        if (draft === undefined)
        {
            draft = new WriteRulesDraft()
            writes.set(key, draft)
        }
        return draft
    }

    private static HasRow(scope: AccessScope, keys: ReadonlySet<string>): boolean
    {
        for (const key of keys)
        {
            if (scope.Rows.has(key)) return true
        }
        return false
    }

    private static HasRule(scope: AccessScope, keys: ReadonlySet<string>, rule: WriteRule): boolean
    {
        for (const key of keys)
        {
            if (scope.Writes.get(key)?.[rule] !== undefined) return true
        }
        return false
    }
}
