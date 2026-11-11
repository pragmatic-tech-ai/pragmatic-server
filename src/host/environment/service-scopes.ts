import { EdgeDirection, IdIn, Related } from '@pragmatic-tech-ai/graph'
import type { AccessScope } from '@pragmatic-tech-ai/graph'
import { SystemNames, TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { WriteRule } from '../engine/access-scope-conjunction.js'
import type { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { ScopeDraft } from '../engine/scope-draft.js'

/**
 * The share service scopes (rulings S8, R31): the only scopes that create, update or delete a `todl.system.ShareGrant`.
 *
 * - `For(scope, grantIds)`: the caller scope with `Rows[ShareGrant] = Or(<the caller's grant rows>, IdIn(grantIds))`
 *   (the addressed grant is visible whoever it is to) and `Writes[ShareGrant]` Create / Update / Delete =
 *   `IdIn(grantIds)`, so the engine confines the transaction's grant writes to exactly those grants. Every other key
 *   is the caller's: the shared record is still read, and linked to, under the caller's rules.
 * - `Listing(scope, record)`: the caller scope with `Rows[ShareGrant]` ORed with `Related(record, Out, IdIn{record})`,
 *   so every grant of that one record is visible (and no other grant beyond the caller's own); it writes nothing more
 *   than the caller scope.
 */
export class ShareServiceScope
{
    private static readonly GrantRules: readonly WriteRule[] = [WriteRule.Create, WriteRule.Update, WriteRule.Delete]

    public static For(scope: AccessScope, grantIds: ReadonlySet<string>, catalog: EngineSchemaCatalog): AccessScope
    {
        const draft = new ScopeDraft(scope, catalog)
        const grants = new IdIn(grantIds)
        draft.OrRow(SystemNames.ShareGrant, grants)
        for (const rule of ShareServiceScope.GrantRules) draft.SetRule(SystemNames.ShareGrant, rule, grants)
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
 *   only. The root `todl.Element` rule is kept (ruling S5 (d): a seeded record stays read-only).
 * - `ReadOnlyExact.Update[concept]` = every member of the concept except `ownershipMembers`, so any other member the
 *   transaction sets is `AccessError MemberReadOnly`. The caller's Create stage of that entry is kept.
 *
 * Rows are the caller's: the record must be visible to the caller.
 */
export class AssignScope
{
    public static For(scope: AccessScope, concept: string, recordId: string, ownershipMembers: ReadonlySet<string>, catalog: EngineSchemaCatalog): AccessScope
    {
        const draft = new ScopeDraft(scope, catalog)
        const record = new IdIn(new Set([recordId]))
        draft.SetRule(concept, WriteRule.Update, record)
        for (const key of catalog.Applicable(concept))
        {
            if (key === concept || key === TodlNames.Element) continue
            if (scope.Writes.get(key)?.Update !== undefined) draft.SetRule(key, WriteRule.Update, record)
        }
        const others = new Set(catalog.Members(concept).filter(member => !ownershipMembers.has(member)))
        const create = scope.Writes.get(concept)?.ReadOnlyExact?.Create
        draft.SetReadOnlyExact(concept, { ...(create === undefined ? {} : { Create: create }), Update: others })
        return draft.Build()
    }
}
