import { ValueType } from '@pragmatic-tech-ai/graph'
import type { CellValue } from '@pragmatic-tech-ai/graph'
import { Cardinality } from '@pragmatic-tech-ai/todl'
import { CellConverter } from '@pragmatic-tech-ai/todl/engine'
import type { EngineSchemaCatalog } from './engine/engine-schema-catalog.js'

/** The subset of a TODL reflection field the legacy check reads (the real FieldInfo is structurally assignable). */
export interface IConceptField
{
    name: string
    cardinality: Cardinality
    fieldType: IConceptType | undefined
}

/** The subset of a TODL reflection type the legacy check reads (the real TypeInfo is structurally assignable). */
export interface IConceptType
{
    name: string
    baseType: IConceptType | undefined
    getField(name: string): IConceptField | undefined
    getFields(): IConceptField[]
    getRelationships(): { name: string }[]
}

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
 * takes a string, Boolean a boolean, Float64 a finite number, Int64 a safe integer), and on create a property the
 * description marks `Nullable: false` left out; null clears any property. The accepted fields come back as engine
 * cells (Int64 as bigint). `Validate` is the same check over a TODL reflected type, kept for the connector hydrate
 * writer until `connector/*` moves to the engine (Task 11). The reasons are shared and unchanged.
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

    public Check(catalog: EngineSchemaCatalog, concept: string, create: boolean, fields: Record<string, unknown> | undefined): ICheckedPayload
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
        if (create)
        {
            const missing = catalog.RequiredProperties(concept).find(name => !(name in payload))
            if (missing !== undefined)
            {
                return { Reason: RuntimeWritePayloadValidator.MissingRequiredPrefix + missing }
            }
        }
        return { Cells: cells }
    }

    public Validate(type: IConceptType | undefined, create: boolean, fields: Record<string, unknown> | undefined): string | undefined
    {
        if (type === undefined)
        {
            return RuntimeWritePayloadValidator.UnknownConcept
        }
        const payload = fields ?? {}
        for (const key of Object.keys(payload))
        {
            const reason = this.ValidateField(type, key, payload[key])
            if (reason !== undefined)
            {
                return reason
            }
        }
        if (create)
        {
            return this.ValidateRequired(type, payload)
        }
        return undefined
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

    private ValidateField(type: IConceptType, key: string, value: unknown): string | undefined
    {
        const field = type.getField(key)
        if (field === undefined)
        {
            if (type.getRelationships().some(r => r.name === key))
            {
                return RuntimeWritePayloadValidator.ReferenceMemberPrefix + key
            }
            return RuntimeWritePayloadValidator.UnknownFieldPrefix + key
        }
        if (value === null)
        {
            return undefined
        }
        if (!this.IsScalar(value))
        {
            return RuntimeWritePayloadValidator.NotScalarPrefix + key
        }
        const expected = this.BasePrimitive(field.fieldType)
        if (expected !== undefined && typeof value !== expected)
        {
            return RuntimeWritePayloadValidator.TypeMismatchPrefix + key
        }
        return undefined
    }

    private ValidateRequired(type: IConceptType, payload: Record<string, unknown>): string | undefined
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

    private BasePrimitive(type: IConceptType | undefined): string | undefined
    {
        let current = type
        while (current !== undefined)
        {
            const name = current.name
            if (name === RuntimeWritePayloadValidator.StringPrimitive
                || name === RuntimeWritePayloadValidator.NumberPrimitive
                || name === RuntimeWritePayloadValidator.BooleanPrimitive)
            {
                return name
            }
            current = current.baseType
        }
        return undefined
    }
}
