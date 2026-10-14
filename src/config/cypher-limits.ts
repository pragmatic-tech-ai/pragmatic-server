/** Execution limits applied to every cypher/query request; overridable via ServerConfig. */
export class CypherLimits
{
    public static readonly DefaultRowCap = 1000
    public static readonly DefaultTimeoutMs = 5000
    public static readonly DefaultMaxVarLength = 10

    public readonly RowCap: number
    public readonly TimeoutMs: number
    public readonly MaxVarLength: number

    public constructor(rowCap?: number, timeoutMs?: number, maxVarLength?: number)
    {
        this.RowCap = rowCap ?? CypherLimits.DefaultRowCap
        this.TimeoutMs = timeoutMs ?? CypherLimits.DefaultTimeoutMs
        this.MaxVarLength = maxVarLength ?? CypherLimits.DefaultMaxVarLength
    }
}
