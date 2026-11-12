import { EdgeDirection, IdIn, Related } from '@pragmatic-tech-ai/graph'
import type { AccessScope } from '@pragmatic-tech-ai/graph'
import { SystemNames, TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { WriteRule } from '../engine/access-scope-conjunction.js'
import type { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { ScopeDraft } from '../engine/scope-draft.js'

/**
 * The share service scopes (rulings S8, R31): the only scopes that create, update or delete a `todl.system.ShareGrant`.
 *
 * - `For(scope, grantIds, record)`: the caller scope with `Rows[ShareGrant] = Or(<the caller's grant rows>,
 *   IdIn(grantIds))` (the addressed grant is visible whoever it is to) and `Writes[ShareGrant]` Create / Update /
 *   Delete / Append = `IdIn(grantIds)`, so the engine confines the transaction's grant writes and links to exactly
 *   those grants; every other AppendTo rule becomes `IdIn({record})` and `IdIn({record})` is ANDed into the root
 *   `todl.Element` AppendTo rule, so the one node they may link to is the shared record, whatever AppendTo the caller
 *   holds on it (the service authorized the share; a reshare through a grant holds no AppendTo, tier 1 widens none).
 *   Rows are the caller's: the shared record must be visible to the caller.
 * - `Listing(scope, record)`: the caller scope with `Rows[ShareGrant]` ORed with `Related(record, Out, IdIn{record})`,
 *   so every grant of that one record is visible (and no other grant beyond the caller's own); it writes nothing more
 *   than the caller scope.
 */
export class ShareServiceScope
{
    private static readonly GrantRules: readonly WriteRule[] = [WriteRule.Create, WriteRule.Update, WriteRule.Delete, WriteRule.Append]

    public static For(scope: AccessScope, grantIds: ReadonlySet<string>, record: string, catalog: EngineSchemaCatalog): AccessScope
    {
        const draft = new ScopeDraft(scope, catalog)
        const grants = new IdIn(grantIds)
        draft.OrRow(SystemNames.ShareGrant, grants)
        for (const rule of ShareServiceScope.GrantRules) draft.SetRule(SystemNames.ShareGrant, rule, grants)
        // the grant's `record` link is the service's, authorized by the share itself: the shared record is the one node
        // it may link to, whatever AppendTo the caller holds on it (a reshare through a grant holds none)
        const shared = new IdIn(new Set([record]))
        for (const key of draft.RuleKeys(WriteRule.AppendTo).filter(key => key !== SystemNames.ShareGrant)) draft.SetRule(key, WriteRule.AppendTo, shared)
        if (catalog.IsConcept(TodlNames.Element)) draft.AndRule(TodlNames.Element, WriteRule.AppendTo, shared)
        return draft.Build()
    }

    public static Listing(scope: AccessScope, record: string, catalog: EngineSchemaCatalog): AccessScope
    {
        const draft = new ScopeDraft(scope, catalog)
        draft.OrRow(SystemNames.ShareGrant, new Related(SystemNames.Record, EdgeDirection.Out, new IdIn(new Set([record]))))
        return draft.Build()
    }
}

/**
 * The assign service scope (ruling S9): assign bypasses the Update gate (as before) but writes nothing beyond the
 * record's ownership members.
 *
 * - `Writes[K].Update = IdIn({recordId})` for the record's concept and every applicable key (ancestor or aspect) that
 *   carries an Update rule in the caller scope, replacing the caller's rule: the update is admitted on that one record
 *   only. Append (a link from a node, R129) likewise, so assign links from no other node. The root `todl.Element`
 *   rules are kept (ruling S5 (d): a seeded record stays read-only).
 * - `ReadOnlyExact.Update[concept]` = every member of the concept except `ownershipMembers`, so any other member the
 *   transaction sets is `AccessError MemberReadOnly`. The caller's Create stage of that entry is kept.
 *
 * Rows are the caller's: the record must be visible to the caller.
 */
export class AssignScope
{
    private static readonly RecordRules: readonly WriteRule[] = [WriteRule.Update, WriteRule.Append]

    public static For(scope: AccessScope, concept: string, recordId: string, ownershipMembers: ReadonlySet<string>, catalog: EngineSchemaCatalog): AccessScope
    {
        return AssignScope.ForRecords(scope, concept, new Set([recordId]), ownershipMembers, catalog)
    }

    /** `For` over several records of `concept` at once (the deploy ownership backfill, PR16): updates admitted on those only. */
    public static ForRecords(scope: AccessScope, concept: string, recordIds: ReadonlySet<string>, ownershipMembers: ReadonlySet<string>, catalog: EngineSchemaCatalog): AccessScope
    {
        const draft = new ScopeDraft(scope, catalog)
        const record = new IdIn(recordIds)
        for (const rule of AssignScope.RecordRules)
        {
            draft.SetRule(concept, rule, record)
            for (const key of catalog.Applicable(concept))
            {
                if (key === concept || key === TodlNames.Element) continue
                if (scope.Writes.get(key)?.[rule] !== undefined) draft.SetRule(key, rule, record)
            }
        }
        const others = new Set(catalog.Members(concept).filter(member => !ownershipMembers.has(member)))
        const create = scope.Writes.get(concept)?.ReadOnlyExact?.Create
        draft.SetReadOnlyExact(concept, { ...(create === undefined ? {} : { Create: create }), Update: others })
        return draft.Build()
    }
}
