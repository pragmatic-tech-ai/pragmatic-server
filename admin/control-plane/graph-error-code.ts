/**
 * JSON-RPC server-error codes for the graph catalog (-32040..-32045).
 * A by-value copy of src/host/graphs/graph-error-codes.ts; a parity test keeps the two in step.
 */
export enum GraphErrorCode
{
    NotFound = -32040,
    Exists = -32041,
    NameInvalid = -32042,
    PackageConflict = -32043,
    PackageSegment = -32044,
    PackageMissing = -32045,
}

export class GraphWireCodes
{
    private static readonly Known: ReadonlySet<number> = new Set<number>(
        Object.values(GraphErrorCode).filter((v): v is number => typeof v === 'number'))

    /** True when the code is one of the graph catalog codes. */
    public static Includes(code: number | undefined): code is GraphErrorCode
    {
        return code !== undefined && GraphWireCodes.Known.has(code)
    }
}
