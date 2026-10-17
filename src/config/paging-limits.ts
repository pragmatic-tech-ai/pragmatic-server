/** Page-size limits applied to every paged wire request; overridable via ServerConfig. */
export class PagingLimits
{
    public static readonly DefaultPageSize = 500
    public static readonly DefaultMaxPageSize = 5000
    private static readonly DefaultExceedsMax = 'PRAGMATIC_PAGE_SIZE_DEFAULT must not exceed PRAGMATIC_PAGE_SIZE_MAX'

    public readonly PageSize: number
    public readonly MaxPageSize: number

    public constructor(pageSize?: number, maxPageSize?: number)
    {
        this.PageSize = pageSize ?? PagingLimits.DefaultPageSize
        this.MaxPageSize = maxPageSize ?? PagingLimits.DefaultMaxPageSize
        if (this.PageSize > this.MaxPageSize)
        {
            throw new Error(PagingLimits.DefaultExceedsMax)
        }
    }
}
