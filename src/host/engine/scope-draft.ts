import { AccessDefault, AccessScope, ConceptIs, FalsePredicate, Not, Or, TruePredicate } from '@pragmatic-tech-ai/graph'
import type { IReadOnlyMembers, IWriteRules, Predicate } from '@pragmatic-tech-ai/graph'
import { AccessScopeConjunction, PredicateFold, WriteRule } from './access-scope-conjunction.js'
import type { EngineSchemaCatalog } from './engine-schema-catalog.js'

/** Folds disjunctions so a constant never leaves a needless tree (False is the identity, True absorbs). */
export class PredicateAny
{
    public static Or(left: Predicate, right: Predicate): Predicate
    {
        if (left === FalsePredicate.Instance) return right
        if (right === FalsePredicate.Instance) return left
        if (left === TruePredicate.Instance || right === TruePredicate.Instance) return TruePredicate.Instance
        return new Or([...PredicateAny.Terms(left), ...PredicateAny.Terms(right)])
    }

    private static Terms(p: Predicate): readonly Predicate[]
    {
        return p instanceof Or ? p.Terms : [p]
    }
}

/**
 * A mutable copy of an engine scope's Rows and write predicates, for the runtime Finish steps (ruling S5) and the
 * service scopes. Hidden, HiddenExact and ReadOnly are carried unchanged; ReadOnlyExact too, unless `SetReadOnlyExact`
 * replaces a key's.
 *
 * `MaterializeDefault` makes a `Default: Deny` explicit (the M1 rule, ruling R93): every described concept none of
 * whose applicable keys has a Rows entry (or a rule of one write operation) in the scope gets its own
 * `Not(ConceptIs K)` entry, which denies K's own instances exactly as the Default did and is neutral on every other
 * node. Afterwards every described concept has an entry to OR a widening into or AND a guard onto, and adding one never
 * lets the Default stop deciding a node it used to deny. An `And` onto a key with no entry starts from what the
 * Default grants that key's own instances (Allow: nothing to AND onto; Deny: `Not(ConceptIs K)`).
 */
export class ScopeDraft
{
    private readonly rows: Map<string, Predicate>
    private readonly writes = new Map<string, Map<WriteRule, Predicate>>()
    private readonly readOnlyExact = new Map<string, IReadOnlyMembers>()

    public constructor(private readonly scope: AccessScope, private readonly catalog: EngineSchemaCatalog)
    {
        this.rows = new Map(scope.Rows)
        for (const [key, rules] of scope.Writes)
        {
            const draft = this.Rules(key)
            for (const rule of AccessScopeConjunction.Rules)
            {
                const predicate = rules[rule]
                if (predicate !== undefined) draft.set(rule, predicate)
            }
        }
    }

    public get Default(): AccessDefault
    {
        return this.scope.Default
    }

    public MaterializeDefault(): void
    {
        if (this.scope.Default !== AccessDefault.Deny) return
        for (const concept of this.catalog.Concepts())
        {
            const keys = [...this.catalog.Applicable(concept)]
            const own = new Not(new ConceptIs(concept))
            if (!keys.some(key => this.scope.Rows.has(key))) this.rows.set(concept, PredicateFold.And(this.rows.get(concept), own))
            for (const rule of AccessScopeConjunction.Rules)
            {
                if (!keys.some(key => this.scope.Writes.get(key)?.[rule] !== undefined)) this.Rules(concept).set(rule, PredicateFold.And(this.Rules(concept).get(rule), own))
            }
        }
    }

    /** The keys that have a Rows entry. */
    public RowKeys(): readonly string[]
    {
        return [...this.rows.keys()]
    }

    /** The keys that have a rule for `rule`. */
    public RuleKeys(rule: WriteRule): readonly string[]
    {
        return [...this.writes].filter(([, rules]) => rules.has(rule)).map(([key]) => key)
    }

    public SetRow(key: string, predicate: Predicate): void
    {
        this.rows.set(key, predicate)
    }

    public OrRow(key: string, predicate: Predicate): void
    {
        this.rows.set(key, PredicateAny.Or(this.rows.get(key) ?? this.Start(key), predicate))
    }

    public SetRule(key: string, rule: WriteRule, predicate: Predicate): void
    {
        this.Rules(key).set(rule, predicate)
    }

    public OrRule(key: string, rule: WriteRule, predicate: Predicate): void
    {
        this.Rules(key).set(rule, PredicateAny.Or(this.Rules(key).get(rule) ?? this.Start(key), predicate))
    }

    public AndRule(key: string, rule: WriteRule, predicate: Predicate): void
    {
        const current = this.Rules(key).get(rule) ?? (this.scope.Default === AccessDefault.Deny ? this.Start(key) : undefined)
        this.Rules(key).set(rule, PredicateFold.And(current, predicate))
    }

    /** Replaces `key`'s ReadOnlyExact members (the scope's own entry for `key` is dropped). */
    public SetReadOnlyExact(key: string, members: IReadOnlyMembers): void
    {
        this.Rules(key)
        this.readOnlyExact.set(key, members)
    }

    public Build(): AccessScope
    {
        const writes = new Map<string, IWriteRules>()
        for (const [key, rules] of this.writes)
        {
            const original = this.scope.Writes.get(key)
            const exact = this.readOnlyExact.get(key) ?? original?.ReadOnlyExact
            writes.set(key, {
                ...(original?.ReadOnly === undefined ? {} : { ReadOnly: original.ReadOnly }),
                ...(exact === undefined ? {} : { ReadOnlyExact: exact }),
                ...Object.fromEntries(rules),
            })
        }
        return AccessScope.Build({ Default: this.scope.Default, Rows: this.rows, Writes: writes, Hidden: this.scope.Hidden, HiddenExact: this.scope.HiddenExact })
    }

    /** What the Default grants `key`'s own instances, as the entry an Or or And starts from. */
    private Start(key: string): Predicate
    {
        return this.scope.Default === AccessDefault.Deny ? new Not(new ConceptIs(key)) : TruePredicate.Instance
    }

    private Rules(key: string): Map<WriteRule, Predicate>
    {
        let rules = this.writes.get(key)
        if (rules === undefined)
        {
            rules = new Map()
            this.writes.set(key, rules)
        }
        return rules
    }
}
