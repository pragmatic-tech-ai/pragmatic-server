import { EdgeDirection, IdIn, Related } from '@pragmatic-tech-ai/graph'
import type { AccessScope } from '@pragmatic-tech-ai/graph'
import { SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { WriteRule } from '../engine/access-scope-conjunction.js'
import type { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { ScopeDraft } from './scope-draft.js'

/**
 * The data/write service scope (rulings S10, R31, R40): a caller scope never writes a `todl.system.ShareGrant` (Finish
 * sets its Create / Update / Delete False), so the delete of records that grants link to runs under the caller scope
 * widened as follows:
 *
 * - `Rows[ShareGrant]` ORed with `IdIn(grantIds)` (a grant shared with someone else is not one the caller sees, and a
 *   delete of an invisible node is refused) and with `Related(record, Out, IdIn(records))`: every grant linking one of
 *   the deleted records is visible to the transaction, so its in-transaction re-read sees a grant linked after the
 *   pre-read whoever it is addressed to (R40).
 * - `Writes[ShareGrant].Delete = IdIn(grantIds)`: only the pre-read grants may be deleted.
 *
 * Nothing else changes: each record's own delete is still judged by the caller's rules, in the same transaction. No
 * deleted records and no grants: the scope unchanged.
 */
export class DeleteGrantsScope
{
    public static For(scope: AccessScope, grantIds: ReadonlySet<string>, catalog: EngineSchemaCatalog, records: ReadonlySet<string> = new Set<string>()): AccessScope
    {
        if (grantIds.size === 0 && records.size === 0) return scope
        const draft = new ScopeDraft(scope, catalog)
        if (records.size > 0) draft.OrRow(SystemNames.ShareGrant, new Related(SystemNames.Record, EdgeDirection.Out, new IdIn(records)))
        if (grantIds.size > 0)
        {
            const grants = new IdIn(grantIds)
            draft.OrRow(SystemNames.ShareGrant, grants)
            draft.SetRule(SystemNames.ShareGrant, WriteRule.Delete, grants)
        }
        return draft.Build()
    }
}
