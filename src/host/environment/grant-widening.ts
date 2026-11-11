import { ShareGrantScope, ShareRight, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import type { IShareSubjects } from '@pragmatic-tech-ai/todl/engine'
import { WriteRule } from '../engine/access-scope-conjunction.js'
import type { ScopeDraft } from '../engine/scope-draft.js'

/**
 * The runtime share widening (ruling S5 Finish (a) and (b), as amended by A3): records shared with the caller become
 * visible, updatable and deletable through their grants, and the caller sees exactly its own grants.
 *
 * (a) A `Default: Deny` is first made explicit per described concept (ScopeDraft.MaterializeDefault), so the widening
 * reaches concepts with no entry too (parity: today's share widening wrapped even a DenyAll filter). Then every Rows
 * entry of a key `widens` admits becomes `Or(E, ShareGrantScope.Widening(s, Read))`, every Update rule
 * `Or(U, Widening(s, Update))`, every Delete rule `Or(D, Widening(s, Delete))`. `Widening` carries the exact
 * `ConceptIs(todl.system.ShareGrant)` guard on the far node (R114), so a lookalike concept cannot forge a grant.
 * `widens` admits only a delivered package's own concepts: never a built-in (`todl.Element`, `todl.Term`), a system
 * or a connector-bound one (A3: connector data is outside platform security).
 *
 * (b) `Rows[ShareGrant] = ShareGrantScope.GrantRows(s)`: required, since a Related target is judged under the same
 * scope (R66) and a scope whose grant rows are False widens nothing (R114). (`Writes[ShareGrant]` Create / Update /
 * Delete False is set by EnvironmentScopeRules.Finish for every scope, with or without identity, ruling R31.)
 */
export class GrantWidening
{
    private static readonly Widened: readonly (readonly [WriteRule, ShareRight])[] = [
        [WriteRule.Update, ShareRight.Update],
        [WriteRule.Delete, ShareRight.Delete],
    ]

    public static Apply(draft: ScopeDraft, subjects: IShareSubjects, widens: (key: string) => boolean): void
    {
        draft.MaterializeDefault()
        const read = ShareGrantScope.Widening(subjects, ShareRight.Read)
        for (const key of draft.RowKeys().filter(widens)) draft.OrRow(key, read)
        for (const [rule, right] of GrantWidening.Widened)
        {
            const widening = ShareGrantScope.Widening(subjects, right)
            for (const key of draft.RuleKeys(rule).filter(widens)) draft.OrRule(key, rule, widening)
        }
        draft.SetRow(SystemNames.ShareGrant, ShareGrantScope.GrantRows(subjects))
    }
}
