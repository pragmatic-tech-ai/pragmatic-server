/** A JSON-safe wire scalar value. */
export type WireScalarValue = string | number | boolean | null

/** Maps engine values to wire scalars: primitives pass through, null/undefined become null, anything else is stringified. */
export class WireScalar
{
    public static Of(value: unknown): WireScalarValue
    {
        if (value === null || value === undefined) { return null }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return value }
        return String(value)
    }

    public static Record(snapshot: Record<string, unknown>): Record<string, WireScalarValue>
    {
        const out: Record<string, WireScalarValue> = {}
        for (const key of Object.keys(snapshot))
        {
            out[key] = WireScalar.Of(snapshot[key])
        }
        return out
    }
}
