import { ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ConnectorFilterTermDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { QueryCompareOp, QueryFilterTranslator, UnmappedFilterFieldError } from '@pragmatic-tech-ai/todl'
import type { ConnectorBinding, ExternalFieldValue, QueryComparison, QueryFilter } from '@pragmatic-tech-ai/todl'
import type { IFieldReadMask } from '../host/cypher/field-read-mask.js'

/**
 * Validates and translates a client's paged-read filter (model member names) into the source query's Where (external
 * names). Every term is authoritative, so nothing is dropped: an unknown operator, a malformed operand, an unmapped member
 * or a member the caller's field mask hides is InvalidParams, the last two with ONE message so the error is never an
 * oracle for a secured field's existence.
 */
export class ConnectorReadFilter
{
    private static readonly UnavailableFieldPrefix = 'connector/readPage filter field is not available: '
    private static readonly BadOperatorPrefix = 'connector/readPage filter has an unknown operator: '
    private static readonly BadOperandPrefix = 'connector/readPage filter operand is not a scalar for field: '
    private static readonly BadTermMessage = 'connector/readPage filter terms must be objects with a field and an op'
    private static readonly Operators: ReadonlyMap<string, QueryCompareOp> = new Map(Object.values(QueryCompareOp).map(op => [op as string, op]))

    public static For(binding: ConnectorBinding, terms: readonly ConnectorFilterTermDto[] | undefined, mask: IFieldReadMask | undefined): QueryFilter | undefined
    {
        if (terms === undefined || terms === null || terms.length === 0)
        {
            return undefined
        }
        if (!Array.isArray(terms))
        {
            throw new ResponseError(ErrorCodes.InvalidParams, ConnectorReadFilter.BadTermMessage)
        }
        const model: QueryComparison[] = terms.map(term => ConnectorReadFilter.Term(term, binding, mask))
        try
        {
            return QueryFilterTranslator.Strict(binding, { All: model })
        }
        catch (error)
        {
            if (error instanceof UnmappedFilterFieldError)
            {
                throw new ResponseError(ErrorCodes.InvalidParams, ConnectorReadFilter.UnavailableFieldPrefix + error.Field)
            }
            throw error
        }
    }

    /** A canonical, order-preserving rendering for the cursor fingerprint (a cursor is bound to its filter). */
    public static Canonical(where: QueryFilter | undefined): string
    {
        return where === undefined ? '' : JSON.stringify(where.All.map(t => [t.Field, t.Op, t.Value, t.Values ?? null]))
    }

    private static Term(term: ConnectorFilterTermDto, binding: ConnectorBinding, mask: IFieldReadMask | undefined): QueryComparison
    {
        if (typeof term !== 'object' || term === null || typeof term.field !== 'string' || typeof term.op !== 'string')
        {
            throw new ResponseError(ErrorCodes.InvalidParams, ConnectorReadFilter.BadTermMessage)
        }
        // Availability FIRST, before the operator or operand is looked at: an unmapped member and a masked one must fail
        // identically whatever else is wrong with the term, or the error itself reveals that a secured field exists.
        const mapped = Object.prototype.hasOwnProperty.call(binding.FieldMap, term.field)
        if (!mapped || (mask !== undefined && !mask.CanRead(binding.Concept, term.field)))
        {
            throw new ResponseError(ErrorCodes.InvalidParams, ConnectorReadFilter.UnavailableFieldPrefix + term.field)
        }
        const op = ConnectorReadFilter.Operators.get(term.op)
        if (op === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidParams, ConnectorReadFilter.BadOperatorPrefix + String(term.op))
        }
        if (op === QueryCompareOp.In)
        {
            if (!Array.isArray(term.values) || !term.values.every(v => ConnectorReadFilter.IsScalar(v)))
            {
                throw new ResponseError(ErrorCodes.InvalidParams, ConnectorReadFilter.BadOperandPrefix + term.field)
            }
            return { Field: term.field, Op: op, Value: null, Values: term.values as ExternalFieldValue[] }
        }
        if (op === QueryCompareOp.IsNull || op === QueryCompareOp.IsNotNull)
        {
            return { Field: term.field, Op: op, Value: null }
        }
        if (!ConnectorReadFilter.IsScalar(term.value))
        {
            throw new ResponseError(ErrorCodes.InvalidParams, ConnectorReadFilter.BadOperandPrefix + term.field)
        }
        return { Field: term.field, Op: op, Value: term.value as ExternalFieldValue }
    }

    private static IsScalar(value: unknown): boolean
    {
        return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
    }
}
