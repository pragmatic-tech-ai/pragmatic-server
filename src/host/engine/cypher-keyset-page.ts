import { Cypher, GraphError, GraphErrorCode } from '@pragmatic-tech-ai/graph'
import { CursorStaleError, PageCursorCodec, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { PageParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { PagingLimits } from '../../config/paging-limits.js'
import { PageRequest } from '../paging/page-request.js'

/**
 * One engine Cypher page resolved from the wire PageParams (ruling S11): keyset paging on the engine's own
 * `Cypher.CypherCursor`, so a commit between two pages neither repeats nor skips a row (M2.1 D8).
 *
 * Wire cursor: the shared `PageCursorCodec` with offset 0 and `fingerprint + '\u0000' + CypherCursor.Encode()` as its
 * fingerprint field, so it is only valid for the fingerprint it was minted for. When the engine reports more rows but
 * no `NextCursor` (an `ORDER BY` over an expression that is no returned column), the chain falls back to offset paging
 * (Q10): the wire cursor carries the next offset and the bare fingerprint, and the following pages run with `Skip`.
 * A malformed cursor, a foreign fingerprint or an embedded Cypher cursor the engine cannot decode is CursorStale.
 *
 * The first page runs with `{ Skip: 0, RowCap }` (RowCap alone is the engine's truncating, non-paged mode), a keyset
 * continuation with `{ After, RowCap }`, never both.
 */
export class CypherKeysetPage
{
    private static readonly KeySeparator = '\u0000'
    private static readonly KeysetOffset = 0
    private static readonly LostCursorMessage = 'invariant: a keyset Cypher page has more rows but the engine returned no cursor'

    private constructor(
        public readonly After: Cypher.CypherCursor | undefined,
        /** 0 unless the chain fell back to offset paging (Q10). */
        public readonly Offset: number,
        public readonly Size: number,
        private readonly fingerprint: string)
    {
    }

    /** Decodes `params.cursor` against `fingerprint` (else CursorStale) and clamps the page size to the limits and `cap`. */
    public static Resolve(params: PageParams, fingerprint: string, limits: PagingLimits, cap?: number): CypherKeysetPage
    {
        const size = PageRequest.SizeOf(params, limits, cap)
        const cursor: unknown = params?.cursor
        if (cursor === undefined || cursor === null) return new CypherKeysetPage(undefined, 0, size, fingerprint)
        const decoded = typeof cursor === 'string' ? PageCursorCodec.Decode(cursor) : undefined
        if (decoded === undefined) throw CypherKeysetPage.Stale()
        if (decoded.fingerprint === fingerprint) return new CypherKeysetPage(undefined, decoded.offset, size, fingerprint)
        const prefix = `${fingerprint}${CypherKeysetPage.KeySeparator}`
        if (decoded.offset !== CypherKeysetPage.KeysetOffset || !decoded.fingerprint.startsWith(prefix)) throw CypherKeysetPage.Stale()
        return new CypherKeysetPage(CypherKeysetPage.DecodeEngineCursor(decoded.fingerprint.slice(prefix.length)), 0, size, fingerprint)
    }

    /** The engine limits for this page: `{ After, RowCap }` on a keyset continuation, else `{ Skip: Offset, RowCap }`. */
    public Limits(cancel?: Cypher.ICancellation): Cypher.ExecutionLimits
    {
        const position = this.After === undefined ? { Skip: this.Offset } : { After: this.After }
        return { ...position, RowCap: this.Size, ...(cancel === undefined ? {} : { Cancel: cancel }) }
    }

    /** The wire cursor of the page after `result`: keyset from `result.NextCursor`, else the next offset; none at the end. */
    public NextCursor(result: Cypher.CypherResult): string | undefined
    {
        if (result.NextCursor !== undefined)
        {
            return PageCursorCodec.Encode({ offset: CypherKeysetPage.KeysetOffset, fingerprint: `${this.fingerprint}${CypherKeysetPage.KeySeparator}${result.NextCursor.Encode()}` })
        }
        if (!result.HasMore) return undefined
        // a keyset chain never loses its cursor (the order of one query does not change); an offset from 0 would repeat rows
        if (this.After !== undefined) throw new Error(CypherKeysetPage.LostCursorMessage)
        return PageCursorCodec.Encode({ offset: this.Offset + result.Rows.length, fingerprint: this.fingerprint })
    }

    private static DecodeEngineCursor(text: string): Cypher.CypherCursor
    {
        try
        {
            return Cypher.CypherCursor.Decode(text)
        }
        catch (error)
        {
            if (error instanceof GraphError && error.GraphCode === GraphErrorCode.InvalidArgument) throw CypherKeysetPage.Stale()
            throw error
        }
    }

    private static Stale(): ResponseError
    {
        return new ResponseError(CursorStaleError.Code, CursorStaleError.Message)
    }
}
