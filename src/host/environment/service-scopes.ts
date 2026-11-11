import { IdIn } from '@pragmatic-tech-ai/graph'
import type { AccessScope } from '@pragmatic-tech-ai/graph'
import { SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { WriteRule } from '../engine/access-scope-conjunction.js'
import type { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { ScopeDraft } from './scope-draft.js'

/**
 * The data/write service scope (rulings S10, R31): a caller scope never writes a `todl.system.ShareGrant` (Finish sets
 * its Create / Update / Delete False), so the delete of a record that grants link to runs under the caller scope
 * widened to exactly those grants: `Rows[ShareGrant]` ORed with `IdIn(grantIds)` (a grant shared with someone else is
 * not one the caller sees, and a delete of an invisible node is refused) and `Writes[ShareGrant].Delete =
 * IdIn(grantIds)`. Nothing else changes: the record's own delete is still judged by the caller's rules, in the same
 * transaction. No ids: the scope unchanged.
 */
export class DeleteGrantsScope
{
    public static For(scope: AccessScope, grantIds: ReadonlySet<string>, catalog: EngineSchemaCatalog): AccessScope
    {
        if (grantIds.size === 0) return scope
        const grants = new IdIn(grantIds)
        const draft = new ScopeDraft(scope, catalog)
        draft.OrRow(SystemNames.ShareGrant, grants)
        draft.SetRule(SystemNames.ShareGrant, WriteRule.Delete, grants)
        return draft.Build()
    }
}
