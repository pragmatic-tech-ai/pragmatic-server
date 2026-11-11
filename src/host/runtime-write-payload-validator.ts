import { ValueType } from '@pragmatic-tech-ai/graph'
import type { CellValue } from '@pragmatic-tech-ai/graph'
import { Cardinality } from '@pragmatic-tech-ai/todl'
import { CellConverter } from '@pragmatic-tech-ai/todl/engine'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import type { EngineSchemaCatalog } from './engine/engine-schema-catalog.js'

/** The TODL metadata snapshot whose reflected types say which fields a create requires (R39). */
type ReflectedTypes = IEnvironmentCatalog['Snapshot']

/** A checked write payload: the refusal reason, else the fields as engine cells (absent when refused). */
export interface ICheckedPayload
{
    readonly Reason?: string
    readonly Cells?: ReadonlyMap<string, CellValue>
}

/**
 * Structural validation of a runtime write payload. `Check` (data/write on the environment engine, ruling S10) reads
 * the engine schema description (EngineSchemaCatalog): an unknown concept, a member the concept lacks, a relationship
 * member (not writable through data/write), a non-scalar value, a value its property's ValueType cannot hold (String
 * takes a string, Boolean a boolean, Float64 a finite number, Int64 a safe integer); null clears any property. The accepted fields come back as engine
 * cells (Int64 as bigint). Required-ness is not in the description (TODL describes every property nullable): on create
 * it is read from the concept's TODL reflected type in `types` (a field of cardinality One or OneOrMore left out, ruling
 * R39); `connector/writePaged` passes none (its upserts are partial). The reasons are unchanged.
 */
export class RuntimeWritePayloadValidator
{
    private static readonly UnknownConcept = 'unknown concept'
    private static readonly UnknownFieldPrefix = 'unknown field: '
    private static readonly ReferenceMemberPrefix = 'reference member is not writable: '
    private static readonly MissingRequiredPrefix = 'missing required field: '
    private static readonly NotScalarPrefix = 'field value must be a scalar: '
    private static readonly TypeMismatchPrefix = 'field has the wrong type: '
    private static readonly StringPrimitive = 'string'
    private static readonly NumberPrimitive = 'number'
    private static readonly BooleanPrimitive = 'boolean'

    public Check(catalog: EngineSchemaCatalog, types: ReflectedTypes | undefined, concept: string, create: boolean, fields: Record<string, unknown> | undefined): ICheckedPayload
    {
        if (!catalog.IsConcept(concept))
        {
            return { Reason: RuntimeWritePayloadValidator.UnknownConcept }
        }
        const payload = fields ?? {}
        const cells = new Map<string, CellValue>()
        for (const key of Object.keys(payload))
        {
            const reason = this.CheckField(catalog, concept, key, payload[key], cells)
            if (reason !== undefined)
            {
                return { Reason: reason }
            }
        }
        const type = create ? types?.getType(concept) : undefined
        const missing = type === undefined ? undefined : this.ValidateRequired(type, payload)
        return missing === undefined ? { Cells: cells } : { Reason: missing }
    }

    private CheckField(catalog: EngineSchemaCatalog, concept: string, key: string, value: unknown, cells: Map<string, CellValue>): string | undefined
    {
        const type = catalog.PropertyType(concept, key)
        if (type === undefined)
        {
            return catalog.IsRelationship(concept, key) ? RuntimeWritePayloadValidator.ReferenceMemberPrefix + key : RuntimeWritePayloadValidator.UnknownFieldPrefix + key
        }
        if (value === null)
        {
            cells.set(key, null)
            return undefined
        }
        if (!this.IsScalar(value))
        {
            return RuntimeWritePayloadValidator.NotScalarPrefix + key
        }
        const expected = this.PrimitiveOf(type)
        const conversion = expected === typeof value ? CellConverter.Convert(type, value) : undefined
        if (conversion?.Value === undefined)
        {
            return RuntimeWritePayloadValidator.TypeMismatchPrefix + key
        }
        cells.set(key, conversion.Value)
        return undefined
    }

    /** The JS primitive a wire value of `type` must be (undefined for a type no wire scalar holds). */
    private PrimitiveOf(type: ValueType): string | undefined
    {
        switch (type)
        {
            case ValueType.String:
                return RuntimeWritePayloadValidator.StringPrimitive
            case ValueType.Boolean:
                return RuntimeWritePayloadValidator.BooleanPrimitive
            case ValueType.Int64:
            case ValueType.Float64:
                return RuntimeWritePayloadValidator.NumberPrimitive
            default:
                return undefined
        }
    }

    private ValidateRequired(type: NonNullable<ReturnType<ReflectedTypes['getType']>>, payload: Record<string, unknown>): string | undefined
    {
        for (const field of type.getFields())
        {
            if (this.IsRequired(field.cardinality) && !(field.name in payload))
            {
                return RuntimeWritePayloadValidator.MissingRequiredPrefix + field.name
            }
        }
        return undefined
    }

    private IsRequired(cardinality: Cardinality): boolean
    {
        return cardinality === Cardinality.One || cardinality === Cardinality.OneOrMore
    }

    private IsScalar(value: unknown): value is string | number | boolean
    {
        return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    }
}
