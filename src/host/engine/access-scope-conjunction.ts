import { AccessDefault, AccessScope, And, FalsePredicate, TruePredicate } from '@pragmatic-tech-ai/graph'
import type { IWriteRules, Predicate } from '@pragmatic-tech-ai/graph'
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
}

/** One key's write rules while two scopes are combined. */
class WriteRulesDraft
{
    public readonly Predicates = new Map<WriteRule, Predicate>()
    public ReadOnly: Set<string> | undefined

    public Add(rules: IWriteRules): void
    {
        for (const rule of AccessScopeConjunction.Rules)
        {
            const predicate = rules[rule]
            if (predicate !== undefined) this.And(rule, predicate)
        }
        for (const member of rules.ReadOnly ?? [])
        {
            this.ReadOnly ??= new Set<string>()
            this.ReadOnly.add(member)
        }
    }

    public And(rule: WriteRule, predicate: Predicate): void
    {
        this.Predicates.set(rule, PredicateFold.And(this.Predicates.get(rule), predicate))
    }

    public Rules(): IWriteRules
    {
        return {
            Create: this.Predicates.get(WriteRule.Create),
            Update: this.Predicates.get(WriteRule.Update),
            Delete: this.Predicates.get(WriteRule.Delete),
            ...(this.ReadOnly === undefined ? {} : { ReadOnly: this.ReadOnly }),
        }
    }
}

/**
 * The AND of two access scopes over one engine schema, deny-wins: a node is visible (a write allowed) iff both scopes
 * admit it. Rows on the same key are ANDed, write rules are ANDed per operation, Hidden and ReadOnly are unioned, and
 * the Default is Allow only when both are.
 *
 * A scope's Default only decides a node none of whose keys has an entry in that scope, but the combined scope sees
 * both scopes' entries. So where one scope would leave a concept to its Default Deny while the other has an entry
 * for it, the combined scope carries an explicit False on that concept (per operation for writes), keeping the deny.
 */
export class AccessScopeConjunction
{
    public static readonly Rules: readonly WriteRule[] = [WriteRule.Create, WriteRule.Update, WriteRule.Delete]

    public static And(left: AccessScope, right: AccessScope, catalog: EngineSchemaCatalog): AccessScope
    {
        const rows = new Map<string, Predicate>()
        const writes = new Map<string, WriteRulesDraft>()
        const hidden = new Map<string, Set<string>>()
        for (const scope of [left, right])
        {
            for (const [key, predicate] of scope.Rows) rows.set(key, PredicateFold.And(rows.get(key), predicate))
            for (const [key, rules] of scope.Writes) AccessScopeConjunction.Draft(writes, key).Add(rules)
            for (const [key, members] of scope.Hidden)
            {
                const union = hidden.get(key) ?? new Set<string>()
                for (const member of members) union.add(member)
                hidden.set(key, union)
            }
        }
        for (const concept of catalog.Concepts())
        {
            const keys = catalog.Applicable(concept)
            for (const [self, other] of [[left, right], [right, left]] as const)
            {
                if (self.Default !== AccessDefault.Deny) continue
                if (!AccessScopeConjunction.HasRow(self, keys) && AccessScopeConjunction.HasRow(other, keys)) rows.set(concept, FalsePredicate.Instance)
                for (const rule of AccessScopeConjunction.Rules)
                {
                    if (!AccessScopeConjunction.HasRule(self, keys, rule) && AccessScopeConjunction.HasRule(other, keys, rule))
                    {
                        AccessScopeConjunction.Draft(writes, concept).Predicates.set(rule, FalsePredicate.Instance)
                    }
                }
            }
        }
        const fallback = left.Default === AccessDefault.Allow && right.Default === AccessDefault.Allow ? AccessDefault.Allow : AccessDefault.Deny
        const rules = new Map<string, IWriteRules>()
        for (const [key, draft] of writes) rules.set(key, draft.Rules())
        return AccessScope.Build({ Default: fallback, Rows: rows, Writes: rules, Hidden: hidden })
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
