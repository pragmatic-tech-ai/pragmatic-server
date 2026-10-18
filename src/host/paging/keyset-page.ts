import { CursorStaleError, PageCursorCodec, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { PageParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ExternalFieldValue } from '@pragmatic-tech-ai/todl'
import type { PagingLimits } from '../../config/paging-limits.js'
import { PageRequest } from './page-request.js'

/** A validated keyset page window: the exclusive lower bound (After) and the effective page size. The cursor reuses the
 *  shared PageCursorCodec with a zero offset, carrying the last key as a JSON suffix of the fingerprint field, so a
 *  cursor is only valid for the query fingerprint it was minted for. */
export class KeysetPage
{
    private static readonly KeySeparator = '\u0000'
    private static readonly NoOffset = 0

    public readonly After: ExternalFieldValue | undefined
    public readonly Size: number
    private readonly fingerprint: string

    private constructor(after: ExternalFieldValue | undefined, size: number, fingerprint: string)
    {
        this.After = after
        this.Size = size
        this.fingerprint = fingerprint
    }

    /** Decodes params.cursor against the fingerprint (a mismatch is a stale-cursor error) and clamps pageSize to the limits. */
    public static Resolve(params: PageParams, fingerprint: string, limits: PagingLimits): KeysetPage
    {
        PageRequest.ValidatePageSize(params)
        const size = Math.min(params?.pageSize ?? limits.PageSize, limits.MaxPageSize)
        return new KeysetPage(KeysetPage.AfterOf(params?.cursor, fingerprint), size, fingerprint)
    }

    /** The cursor for the page after this one; undefined nextAfter means the last page, so no cursor. */
    public NextCursor(nextAfter: ExternalFieldValue | undefined): string | undefined
    {
        if (nextAfter === undefined || nextAfter === null)
        {
            return undefined
        }
        return PageCursorCodec.Encode({ offset: KeysetPage.NoOffset, fingerprint: `${this.fingerprint}${KeysetPage.KeySeparator}${JSON.stringify(nextAfter)}` })
    }

    private static AfterOf(cursor: unknown, fingerprint: string): ExternalFieldValue | undefined
    {
        if (cursor === undefined || cursor === null)
        {
            return undefined
        }
        const decoded = typeof cursor === 'string' ? PageCursorCodec.Decode(cursor) : undefined
        const prefix = `${fingerprint}${KeysetPage.KeySeparator}`
        if (decoded === undefined || decoded.offset !== KeysetPage.NoOffset || !decoded.fingerprint.startsWith(prefix))
        {
            throw KeysetPage.Stale()
        }
        try
        {
            const after: unknown = JSON.parse(decoded.fingerprint.slice(prefix.length))
            if (typeof after === 'string' || (typeof after === 'number' && Number.isFinite(after)))
            {
                return after
            }
        }
        catch
        {
            // falls through to the stale error below
        }
        throw KeysetPage.Stale()
    }

    private static Stale(): ResponseError<undefined>
    {
        return new ResponseError(CursorStaleError.Code, CursorStaleError.Message)
    }
}
