import { ValueType } from '@pragmatic-tech-ai/graph'
import type { Cypher } from '@pragmatic-tech-ai/graph'
import { ConnectorFilterOp, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ConnectorFilterTermDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { InvalidParamsPrefix } from '../invalid-params-prefix.js'
import type { EngineSchemaCatalog } from './engine-schema-catalog.js'

/** One translated filter: the Cypher `WHERE` text (empty for no terms), its parameters and its canonical form. */
export interface IConnectorWhere
{
    readonly Text: string
    readonly Parameters: ReadonlyMap<string, Cypher.ParameterValue>
    /** A canonical, order-preserving rendering for the cursor fingerprint (a cursor is bound to its filter). */
    readonly Canonical: string
}

/**
 * A `connector/readPage` filter as a parameterised Cypher `WHERE` over `n.<field>` (ruling S14): every term is an AND
 * conjunct; its field must be a property member of the concept (else InvalidParams "unknown filter field"); the
 * operators map 1:1 (`isNull` / `isNotNull` to `IS NULL` / `IS NOT NULL`, `in` to `IN`); an operand is a value of the
 * member's type (a number for Int64 / Float64, a safe integer for Int64; a string for String; a boolean for Boolean;
 * ISO text for a temporal member), else InvalidParams. What reaches the source is the engine's decision (P10: only
 * `eq` / `in` on String or Boolean members and `isNull` / `isNotNull` are pushed down); this class never filters rows.
 */
export class ConnectorWhereClause
{
    private static readonly Variable = 'n'
    private static readonly ParameterPrefix = 'w'
    private static readonly And = ' AND '
    private static readonly Where = ' WHERE '
    private static readonly UnknownFieldPrefix = `${InvalidParamsPrefix.Text}unknown filter field: `
    private static readonly BadOperatorPrefix = `${InvalidParamsPrefix.Text}connector/readPage filter has an unknown operator: `
    private static readonly BadOperandPrefix = `${InvalidParamsPrefix.Text}connector/readPage filter operand does not fit field: `
    private static readonly BadTermMessage = `${InvalidParamsPrefix.Text}connector/readPage filter terms must be objects with a field and an op`
    private static readonly DateKey = '$date'
    private static readonly DateTimeKey = '$datetime'
    private static readonly DurationKey = '$duration'
    private static readonly Comparisons: ReadonlyMap<string, string> = new Map<string, string>([
        [ConnectorFilterOp.Eq, '='],
        [ConnectorFilterOp.Neq, '<>'],
        [ConnectorFilterOp.Lt, '<'],
        [ConnectorFilterOp.Lte, '<='],
        [ConnectorFilterOp.Gt, '>'],
        [ConnectorFilterOp.Gte, '>='],
    ])
    private static readonly IsNull = ' IS NULL'
    private static readonly IsNotNull = ' IS NOT NULL'
    private static readonly In = ' IN '
    private static readonly None: IConnectorWhere = { Text: '', Parameters: new Map(), Canonical: '' }

    private constructor()
    {
    }

    public static Of(terms: readonly ConnectorFilterTermDto[] | undefined | null, concept: string, catalog: EngineSchemaCatalog): IConnectorWhere
    {
        if (terms === undefined || terms === null || (Array.isArray(terms) && terms.length === 0)) return ConnectorWhereClause.None
        if (!Array.isArray(terms)) throw ConnectorWhereClause.Invalid(ConnectorWhereClause.BadTermMessage)
        const conjuncts: string[] = []
        const parameters = new Map<string, Cypher.ParameterValue>()
        for (const term of terms) conjuncts.push(ConnectorWhereClause.Term(term, concept, catalog, parameters))
        const canonical = JSON.stringify(terms.map(term => [term.field, term.op, term.value ?? null, term.values ?? null]))
        return { Text: ConnectorWhereClause.Where + conjuncts.join(ConnectorWhereClause.And), Parameters: parameters, Canonical: canonical }
    }

    private static Term(term: ConnectorFilterTermDto, concept: string, catalog: EngineSchemaCatalog, parameters: Map<string, Cypher.ParameterValue>): string
    {
        if (typeof term !== 'object' || term === null || typeof term.field !== 'string' || typeof term.op !== 'string')
        {
            throw ConnectorWhereClause.Invalid(ConnectorWhereClause.BadTermMessage)
        }
        const type = catalog.PropertyType(concept, term.field)
        if (type === undefined) throw ConnectorWhereClause.Invalid(ConnectorWhereClause.UnknownFieldPrefix + term.field)
        // the member is a declared property of the concept, so the identifier is safe; quoted all the same
        const subject = `${ConnectorWhereClause.Variable}.\`${term.field}\``
        if (term.op === ConnectorFilterOp.IsNull) return subject + ConnectorWhereClause.IsNull
        if (term.op === ConnectorFilterOp.IsNotNull) return subject + ConnectorWhereClause.IsNotNull
        const name = ConnectorWhereClause.ParameterPrefix + parameters.size
        if (term.op === ConnectorFilterOp.In)
        {
            if (!Array.isArray(term.values)) throw ConnectorWhereClause.Invalid(ConnectorWhereClause.BadOperandPrefix + term.field)
            parameters.set(name, term.values.map(value => ConnectorWhereClause.Operand(value, type, term.field)))
            return `${subject}${ConnectorWhereClause.In}$${name}`
        }
        const comparison = ConnectorWhereClause.Comparisons.get(term.op)
        if (comparison === undefined) throw ConnectorWhereClause.Invalid(ConnectorWhereClause.BadOperatorPrefix + String(term.op))
        parameters.set(name, ConnectorWhereClause.Operand(term.value, type, term.field))
        return `${subject} ${comparison} $${name}`
    }

    /** `value` as a Cypher parameter of the member's type (null stays null: SQL semantics, it matches nothing). */
    private static Operand(value: unknown, type: ValueType, field: string): Cypher.ParameterValue
    {
        if (value === null) return null
        switch (type)
        {
            case ValueType.String:
                if (typeof value === 'string') return value
                break
            case ValueType.Boolean:
                if (typeof value === 'boolean') return value
                break
            case ValueType.Int64:
                if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
                break
            case ValueType.Float64:
                if (typeof value === 'number' && Number.isFinite(value)) return value
                break
            case ValueType.Date:
                if (typeof value === 'string') return { [ConnectorWhereClause.DateKey]: value }
                break
            case ValueType.DateTime:
                if (typeof value === 'string') return { [ConnectorWhereClause.DateTimeKey]: value }
                break
            case ValueType.Duration:
                if (typeof value === 'string') return { [ConnectorWhereClause.DurationKey]: value }
                break
        }
        throw ConnectorWhereClause.Invalid(ConnectorWhereClause.BadOperandPrefix + field)
    }

    private static Invalid(message: string): ResponseError
    {
        return new ResponseError(ErrorCodes.InvalidParams, message)
    }
}
