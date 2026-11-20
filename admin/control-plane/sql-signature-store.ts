import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlRecordStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { ISignatureStore } from './signature-store.js'
import type { SqlRecordMapRow } from './sql-record-map.js'

/**
 * The Postgres signature store of the platform admin console: one row per image digest (`records_signatures`, the
 * SqlRecordMap row shape `{ id: digest, record: { <keyRef>: signature } }`). A signature filed before signatures were
 * keyed sits under the empty key ref and, as in the file store, is answered for any key ref (the verifier checks it
 * cryptographically against the asked key) but never counts as keyed. Put is an optimistic read-modify-write of the
 * digest's row, so two signers of one digest never drop each other's signature.
 */
export class SqlSignatureStore implements ISignatureStore
{
    public static readonly Registry = 'signatures'
    public static readonly LegacyKeyRef = ''

    private constructor(private readonly store: SqlRecordStore<SqlRecordMapRow<Record<string, string>>>)
    {
    }

    public static async Open(session: ISqlSession): Promise<SqlSignatureStore>
    {
        return new SqlSignatureStore(await SqlRecordStore.Open<SqlRecordMapRow<Record<string, string>>>(session, SqlSignatureStore.Registry))
    }

    /** A signature file entry as a row record: a bare (pre-keyed) signature goes under the legacy key ref. */
    public static RecordOf(entry: string | Record<string, string>): Record<string, string>
    {
        return typeof entry === 'string' ? { [SqlSignatureStore.LegacyKeyRef]: entry } : { ...entry }
    }

    public async Get(digest: string, keyRef: string): Promise<string | undefined>
    {
        const signatures = (await this.store.Get(digest))?.record
        if (signatures === undefined)
        {
            return undefined
        }
        if (Object.hasOwn(signatures, keyRef))
        {
            return signatures[keyRef]
        }
        return Object.hasOwn(signatures, SqlSignatureStore.LegacyKeyRef) ? signatures[SqlSignatureStore.LegacyKeyRef] : undefined
    }

    public async HasKeyed(digest: string, keyRef: string): Promise<boolean>
    {
        const signatures = (await this.store.Get(digest))?.record
        return signatures !== undefined && keyRef !== SqlSignatureStore.LegacyKeyRef && Object.hasOwn(signatures, keyRef)
    }

    public async Put(digest: string, keyRef: string, signature: string): Promise<void>
    {
        await this.store.Update(digest, current => ({ id: digest, record: { ...(current?.record ?? {}), [keyRef]: signature } }))
    }
}
