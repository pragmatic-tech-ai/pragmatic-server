import { DateTimeValue, DateValue, DurationValue } from '@pragmatic-tech-ai/graph'
import type { CellValue, Cypher, RowVersion } from '@pragmatic-tech-ai/graph'
import type { EntityDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { WireScalarValue } from '../wire-scalar.js'

/**
 * An engine node as a `connector/read*` EntityDto (ruling S14): `{ id: public id, concept, fields }`, the fields being
 * the node's properties as the reader's scope shows them (a hidden member is absent, an unset one null). A bigint is a
 * number when it is a safe integer, else its decimal text; a temporal value is its ISO text (a date `YYYY-MM-DD`, an
 * instant in UTC, a duration `PnMnDTnS`).
 */
export class ConnectorEntity
{
    private static readonly MillisPerDay = 86400000
    private static readonly DateLength = 10
    private static readonly MicrosPerMilli = 1000n
    private static readonly MicrosPerSecond = 1000000

    private constructor()
    {
    }

    public static Of(node: Cypher.CypherNode): EntityDto
    {
        const fields: Record<string, WireScalarValue> = {}
        for (const [member, value] of node.Properties) fields[member] = ConnectorEntity.Scalar(value)
        return { id: node.PublicId, concept: node.Concept, fields }
    }

    /** A row version as a wire scalar (a bigint as `Scalar` renders it). */
    public static Version(version: RowVersion): WireScalarValue
    {
        return ConnectorEntity.Scalar(version)
    }

    public static Scalar(value: CellValue): WireScalarValue
    {
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
        if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
        if (value instanceof DateValue) return new Date(value.Days * ConnectorEntity.MillisPerDay).toISOString().slice(0, ConnectorEntity.DateLength)
        if (value instanceof DateTimeValue) return new Date(Number(value.Micros / ConnectorEntity.MicrosPerMilli)).toISOString()
        if (value instanceof DurationValue) return `P${value.Months}M${value.Days}DT${Number(value.Micros) / ConnectorEntity.MicrosPerSecond}S`
        return null
    }
}
