import { Cardinality } from '@pragmatic-tech-ai/todl'

/** The subset of a TODL reflection field the validator reads (the real FieldInfo is structurally assignable). */
export interface IConceptField
{
    name: string
    cardinality: Cardinality
    fieldType: IConceptType | undefined
}

/** The subset of a TODL reflection type the validator reads (the real TypeInfo is structurally assignable). */
export interface IConceptType
{
    name: string
    baseType: IConceptType | undefined
    getField(name: string): IConceptField | undefined
    getFields(): IConceptField[]
    getRelationships(): { name: string }[]
}

/** Structural validation of a runtime write payload against a concept's reflected schema. No Repository needed. */
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

    private IsScalar(value: unknown): boolean
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
