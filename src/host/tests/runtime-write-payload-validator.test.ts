import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemberKind, ValueType } from '@pragmatic-tech-ai/graph'
import { Cardinality } from '@pragmatic-tech-ai/todl'
import { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { RuntimeWritePayloadValidator } from '../runtime-write-payload-validator.js'
import type { IConceptType, IConceptField } from '../runtime-write-payload-validator.js'

class FakeType implements IConceptType
{
    public name = 'shop.Order'
    public baseType: IConceptType | undefined = undefined
    constructor(private readonly fields: IConceptField[], private readonly relations: string[] = []) {}
    public getField(name: string): IConceptField | undefined
    {
        return this.fields.find(f => f.name === name)
    }
    public getFields(): IConceptField[]
    {
        return this.fields
    }
    public getRelationships(): { name: string }[]
    {
        return this.relations.map(name => ({ name }))
    }
}

class Schema
{
    public static readonly Validator = new RuntimeWritePayloadValidator()
    public static readonly UnknownConcept = 'unknown concept'
    public static readonly UnknownFieldPrefix = 'unknown field: '
    public static readonly ReferenceMemberPrefix = 'reference member is not writable: '
    public static readonly MissingRequiredPrefix = 'missing required field: '
    public static readonly NotScalarPrefix = 'field value must be a scalar: '
    public static readonly TypeMismatchPrefix = 'field has the wrong type: '

    public static Primitive(name: string): IConceptType
    {
        const t = new FakeType([])
        t.name = name
        return t
    }

    public static Field(name: string, type: string, card: Cardinality): IConceptField
    {
        return { name, cardinality: card, fieldType: Schema.Primitive(type) }
    }
}

test('unknown field is rejected', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.One)])
    assert.equal(Schema.Validator.Validate(type, true, { bogus: 'x' }), Schema.UnknownFieldPrefix + 'bogus')
})

test('reference member is rejected as out-of-scope, distinct from unknown field', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.Optional)], ['customer'])
    assert.equal(Schema.Validator.Validate(type, true, { customer: 'c1' }), Schema.ReferenceMemberPrefix + 'customer')
    assert.equal(Schema.Validator.Validate(type, true, { bogus: 'c1' }), Schema.UnknownFieldPrefix + 'bogus')
})

test('missing required field on create is rejected', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.One)])
    assert.equal(Schema.Validator.Validate(type, true, {}), Schema.MissingRequiredPrefix + 'title')
})

test('missing OneOrMore field on create is rejected', () =>
{
    const type = new FakeType([Schema.Field('tag', 'string', Cardinality.OneOrMore)])
    assert.equal(Schema.Validator.Validate(type, true, {}), Schema.MissingRequiredPrefix + 'tag')
})

test('missing required field on update is allowed (partial validated)', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.One), Schema.Field('note', 'string', Cardinality.Optional)])
    assert.equal(Schema.Validator.Validate(type, false, { note: 'hi' }), undefined)
})

test('scalar type mismatch is rejected', () =>
{
    const type = new FakeType([Schema.Field('count', 'number', Cardinality.One)])
    assert.equal(Schema.Validator.Validate(type, true, { count: 'not-a-number' }), Schema.TypeMismatchPrefix + 'count')
})

test('boolean field given a non-boolean scalar is rejected', () =>
{
    const type = new FakeType([Schema.Field('active', 'boolean', Cardinality.One)])
    assert.equal(Schema.Validator.Validate(type, true, { active: 'yes' }), Schema.TypeMismatchPrefix + 'active')
    assert.equal(Schema.Validator.Validate(type, true, { active: true }), undefined)
})

test('valid create passes', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.One), Schema.Field('count', 'number', Cardinality.Optional)])
    assert.equal(Schema.Validator.Validate(type, true, { title: 'Widget', count: 3 }), undefined)
})

test('null value on a required and an optional field is allowed', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.One), Schema.Field('note', 'string', Cardinality.Optional)])
    assert.equal(Schema.Validator.Validate(type, true, { title: null, note: null }), undefined)
})

test('user-primitive (base string) accepts a string', () =>
{
    const base = Schema.Primitive('string')
    const slug = Schema.Primitive('slug')
    ;(slug as FakeType).baseType = base
    const type = new FakeType([{ name: 'key', cardinality: Cardinality.One, fieldType: slug }])
    assert.equal(Schema.Validator.Validate(type, true, { key: 'abc' }), undefined)
})

test('unknown base primitive is leniently accepted', () =>
{
    const type = new FakeType([Schema.Field('when', 'date', Cardinality.One)])
    assert.equal(Schema.Validator.Validate(type, true, { when: 'anything' }), undefined)
    assert.equal(Schema.Validator.Validate(type, true, { when: 5 }), undefined)
})

test('undefined concept type is rejected', () =>
{
    assert.equal(Schema.Validator.Validate(undefined, true, { title: 'x' }), Schema.UnknownConcept)
})

test('non-scalar object value is rejected as not-scalar only', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.One)])
    assert.equal(Schema.Validator.Validate(type, true, { title: { nested: 1 } as unknown as string }), Schema.NotScalarPrefix + 'title')
})

test('array value is rejected as not-scalar', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.One)])
    assert.equal(Schema.Validator.Validate(type, true, { title: ['a'] as unknown as string }), Schema.NotScalarPrefix + 'title')
})

/** An engine schema description of one concept, shop.Order, and its TODL type, for `Check` (rulings S10, R39). */
class Described
{
    public static readonly Order = 'shop.Order'
    public static readonly Catalog = new EngineSchemaCatalog({
        Version: 'v1',
        Definitions: [{
            Name: Described.Order, IsAspect: false, Parent: null, Aspects: [], Members: [
                { Name: 'title', Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
                { Name: 'count', Kind: MemberKind.Property, Type: ValueType.Int64, Nullable: true },
                { Name: 'price', Kind: MemberKind.Property, Type: ValueType.Float64, Nullable: true },
                { Name: 'active', Kind: MemberKind.Property, Type: ValueType.Boolean, Nullable: true },
                { Name: 'customer', Kind: MemberKind.Relationship, Targets: [Described.Order], Many: false },
            ],
        }],
        Indexes: [], Seed: [], Bindings: [],
    })
    /** The TODL reflected type: `title` is required (cardinality One). */
    public static readonly Type = new FakeType([Schema.Field('title', 'string', Cardinality.One), Schema.Field('count', 'integer', Cardinality.Optional)])
}

test('description check: unknown concept, unknown field and relationship member keep their reasons', () =>
{
    assert.equal(Schema.Validator.Check(Described.Catalog, Described.Type, 'shop.Nope', true, {}).Reason, Schema.UnknownConcept)
    assert.equal(Schema.Validator.Check(Described.Catalog, Described.Type, Described.Order, false, { bogus: 'x' }).Reason, Schema.UnknownFieldPrefix + 'bogus')
    assert.equal(Schema.Validator.Check(Described.Catalog, Described.Type, Described.Order, false, { customer: 'c1' }).Reason, Schema.ReferenceMemberPrefix + 'customer')
})

test('description check: value types, non-scalars and required properties', () =>
{
    const check = (create: boolean, fields: Record<string, unknown>) => Schema.Validator.Check(Described.Catalog, Described.Type, Described.Order, create, fields).Reason
    assert.equal(check(false, { count: 'x' }), Schema.TypeMismatchPrefix + 'count')
    assert.equal(check(false, { count: 1.5 }), Schema.TypeMismatchPrefix + 'count', 'an Int64 takes an integer only')
    assert.equal(check(false, { active: 'yes' }), Schema.TypeMismatchPrefix + 'active')
    assert.equal(check(false, { title: ['a'] }), Schema.NotScalarPrefix + 'title')
    assert.equal(check(true, { count: 1 }), Schema.MissingRequiredPrefix + 'title', 'a field of cardinality One (TODL type) is required on create')
    assert.equal(check(false, { count: 1 }), undefined, 'an update is partial')
    assert.equal(check(true, { title: null }), undefined, 'null is allowed')
})

test('description check returns the fields as engine cells', () =>
{
    const checked = Schema.Validator.Check(Described.Catalog, Described.Type, Described.Order, true, { title: 'Widget', count: 3, price: 2.5, active: true, customer: undefined } as Record<string, unknown>)
    assert.equal(checked.Reason, Schema.ReferenceMemberPrefix + 'customer', 'a relationship is refused whatever its value')
    const cells = Schema.Validator.Check(Described.Catalog, Described.Type, Described.Order, true, { title: 'Widget', count: 3, price: 2.5, active: true }).Cells
    assert.deepEqual([...cells!], [['title', 'Widget'], ['count', 3n], ['price', 2.5], ['active', true]])
})
