import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cardinality } from '@pragmatic-tech-ai/todl'
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
