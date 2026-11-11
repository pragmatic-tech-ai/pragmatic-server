import { EdgeDirection, IdIn, Related } from '@pragmatic-tech-ai/graph'
import type { AccessScope, GraphReader } from '@pragmatic-tech-ai/graph'
import { SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { WriteRule } from './access-scope-conjunction.js'
import type { EngineSchemaCatalog } from './engine-schema-catalog.js'
import type { RecordedBatch } from './recorded-batch.js'
import { ScopeDraft } from './scope-draft.js'

/**
 * The scope a delete of grant-linked records runs under (rulings S10, R31, R40, R49): a caller scope never writes a
 * `todl.system.ShareGrant` (Finish sets its Create / Update / Delete False), so the delete of records that grants link
 * to runs under the caller scope widened as follows:
 *
 * - `Rows[ShareGrant]` ORed with `IdIn(grantIds)` (a grant shared with someone else is not one the caller sees, and a
 *   delete of an invisible node is refused) and with `Related(record, Out, IdIn(records))`: every grant linking one of
 *   the deleted records is visible to the transaction, so its in-transaction re-read sees a grant linked after the
 *   pre-read whoever it is addressed to (R40).
 * - `Writes[ShareGrant].Delete = IdIn(grantIds)`: only the pre-read grants may be deleted.
 *
 * Nothing else changes: each record's own delete is still judged by the caller's rules, in the same transaction. No
 * deleted records and no grants: the scope unchanged. Purpose-free (the names are TODL's SystemNames); a scope with no
 * ShareGrant concept is widened harmlessly.
 */
export class DeleteGrantsScope
{
    private constructor()
    {
    }

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

/**
 * Deleting a record deletes the share grants that link it, in the same transaction (rulings S10, R40, R49), shared by
 * `data/write` and `connector/writeBack`:
 *
 * 1. `PreRead` with a System reader: grant id -> the deleted record it links (`Links(record, In, record)`, kept when the
 *    far node is exactly a `todl.system.ShareGrant`; a lookalike `record` relationship is not a grant).
 * 2. The transaction runs under {@link DeleteGrantsScope} over those grants and records.
 * 3. Per deleted record, `LinkedSince` re-reads its grants in the transaction: one the pre-read missed (linked since)
 *    refuses the batch as a conflict (R40); the re-read is recorded, so OCC refuses a commit racing a later link.
 * 4. `Record` deletes the record's pre-read grants (each once) before the caller deletes the record.
 */
export class RecordGrantDeletion
{
    private constructor()
    {
    }

    /** Grant id -> the deleted record it links, as `reader` sees them. */
    public static async PreRead(reader: GraphReader, records: Iterable<string>): Promise<Map<string, string>>
    {
        const grants = new Map<string, string>()
        for (const record of records)
        {
            for (const grant of await RecordGrantDeletion.GrantsOf(reader, record))
            {
                if (!grants.has(grant)) grants.set(grant, record)
            }
        }
        return grants
    }

    /** True when `reader` (the transaction) sees a grant of `record` the pre-read did not find. */
    public static async LinkedSince(reader: GraphReader, record: string, grants: ReadonlyMap<string, string>): Promise<boolean>
    {
        return (await RecordGrantDeletion.GrantsOf(reader, record)).some(grant => !grants.has(grant))
    }

    /** Records the delete of every pre-read grant of `record` (as op `op`) not deleted yet. */
    public static Record(batch: RecordedBatch, op: number, record: string, grants: ReadonlyMap<string, string>, deleted: Set<string>): void
    {
        for (const [grant, linked] of grants)
        {
            if (linked !== record || deleted.has(grant)) continue
            deleted.add(grant)
            batch.DeleteNode(op, grant)
        }
    }

    /** The ShareGrant nodes `reader` sees linking `record`. */
    private static async GrantsOf(reader: GraphReader, record: string): Promise<string[]>
    {
        const grants: string[] = []
        for (const link of await reader.Links(record, EdgeDirection.In, SystemNames.Record))
        {
            if (await reader.ConceptOf(link.PublicId) === SystemNames.ShareGrant) grants.push(link.PublicId)
        }
        return grants
    }
}
