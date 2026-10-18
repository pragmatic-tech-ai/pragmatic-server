import { createHash } from 'node:crypto'
import { CursorStaleError, ErrorCodes, PageCursorCodec, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { PageParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { PagingLimits } from '../../config/paging-limits.js'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'

/** A stable digest over the inputs that define a paged result; a cursor is only valid for the same fingerprint. */
export class PageFingerprint
{
    private static readonly Algorithm = 'sha256'
    private static readonly Separator = '\u0000'
    private static readonly Digest = 'hex'

    public static Of(...parts: readonly string[]): string
    {
        return createHash(PageFingerprint.Algorithm).update(parts.join(PageFingerprint.Separator)).digest(PageFingerprint.Digest)
    }
}

/** A validated page window resolved from wire PageParams against the server limits and the result fingerprint. */
export class PageRequest
{
    private static readonly BadPageSize = `${InvalidParamsPrefix.Text}pageSize must be a positive integer`

    public readonly Offset: number
    public readonly Size: number
    private readonly fingerprint: string

    private constructor(offset: number, size: number, fingerprint: string)
    {
        this.Offset = offset
        this.Size = size
        this.fingerprint = fingerprint
    }

    /** Rejects a non-positive or non-integer pageSize with InvalidParams; an absent pageSize is valid (the default applies). */
    public static ValidatePageSize(params: PageParams): void
    {
        const pageSize: unknown = params?.pageSize
        if (pageSize === undefined || pageSize === null)
        {
            return
        }
        if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize <= 0)
        {
            throw new ResponseError(ErrorCodes.InvalidParams, PageRequest.BadPageSize)
        }
    }

    public static Resolve(params: PageParams, fingerprint: string, limits: PagingLimits, cap?: number): PageRequest
    {
        PageRequest.ValidatePageSize(params)
        const size = Math.min(params?.pageSize ?? limits.PageSize, limits.MaxPageSize, cap ?? Infinity)
        return new PageRequest(PageRequest.OffsetOf(params?.cursor, fingerprint), size, fingerprint)
    }

    public NextCursor(hasMore: boolean): string | undefined
    {
        if (!hasMore)
        {
            return undefined
        }
        return PageCursorCodec.Encode({ offset: this.Offset + this.Size, fingerprint: this.fingerprint })
    }

    private static OffsetOf(cursor: unknown, fingerprint: string): number
    {
        if (cursor === undefined || cursor === null)
        {
            return 0
        }
        const decoded = typeof cursor === 'string' ? PageCursorCodec.Decode(cursor) : undefined
        if (decoded === undefined || decoded.fingerprint !== fingerprint)
        {
            throw new ResponseError(CursorStaleError.Code, CursorStaleError.Message)
        }
        return decoded.offset
    }
}
