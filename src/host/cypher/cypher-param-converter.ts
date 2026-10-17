import type { CypherParamValue } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { Cypher } from '@pragmatic-tech-ai/todl'

type ParameterValue = Cypher.ParameterValue

/** Raised when a wire parameter is not a representable scalar/null/list/map. */
export class CypherParamError extends Error
{
    public constructor(message: string)
    {
        super(message)
    }
}

/** Converts the wire `CypherParamValue` tree into the engine's `$param` binding map. */
export class CypherParamConverter
{
    private static readonly BadValue = 'unsupported parameter value'

    public static ToMap(parameters: { [k: string]: CypherParamValue } | undefined): ReadonlyMap<string, ParameterValue>
    {
        const map = new Map<string, ParameterValue>()
        if (parameters === undefined || parameters === null)
        {
            return map
        }
        if (typeof parameters !== 'object' || Array.isArray(parameters))
        {
            throw new CypherParamError(CypherParamConverter.BadValue)
        }
        for (const [key, value] of Object.entries(parameters))
        {
            map.set(key, CypherParamConverter.ToValue(value))
        }
        return map
    }

    /** Canonical JSON of the wire parameters (recursively key-sorted), so equal bindings yield equal text regardless of key order. */
    public static Canonical(parameters: { [k: string]: CypherParamValue } | undefined): string
    {
        return JSON.stringify(CypherParamConverter.Sorted(parameters ?? {}))
    }

    private static Sorted(value: unknown): unknown
    {
        if (Array.isArray(value))
        {
            return value.map(v => CypherParamConverter.Sorted(v))
        }
        if (value !== null && typeof value === 'object')
        {
            const record: { [key: string]: unknown } = Object.create(null)
            for (const key of Object.keys(value).sort())
            {
                record[key] = CypherParamConverter.Sorted((value as { [key: string]: unknown })[key])
            }
            return record
        }
        return value
    }

    public static ToValue(value: unknown): ParameterValue
    {
        if (value === null || typeof value === 'string' || typeof value === 'boolean')
        {
            return value
        }
        if (typeof value === 'number')
        {
            if (!Number.isFinite(value))
            {
                throw new CypherParamError(CypherParamConverter.BadValue)
            }
            return value
        }
        if (Array.isArray(value))
        {
            return value.map(v => CypherParamConverter.ToValue(v))
        }
        if (typeof value === 'object')
        {
            // null prototype: a wire key such as __proto__ becomes an ordinary own property
            const record: { [key: string]: ParameterValue } = Object.create(null)
            for (const [key, entry] of Object.entries(value))
            {
                record[key] = CypherParamConverter.ToValue(entry)
            }
            return record
        }
        throw new CypherParamError(CypherParamConverter.BadValue)
    }
}
