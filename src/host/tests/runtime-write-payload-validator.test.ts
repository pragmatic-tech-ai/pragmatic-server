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
    assert.ok(Schema.Validator.Validate(type, true, { bogus: 'x' }))
})

test('reference member is rejected as out-of-scope', () =>
{
    const type = new FakeType([], ['customer'])
    assert.ok(Schema.Validator.Validate(type, true, { customer: 'c1' }))
})

test('missing required field on create is rejected', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.One)])
    assert.ok(Schema.Validator.Validate(type, true, {}))
})

test('missing required field on update is allowed (partial validated)', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.One), Schema.Field('note', 'string', Cardinality.Optional)])
    assert.equal(Schema.Validator.Validate(type, false, { note: 'hi' }), undefined)
})

test('scalar type mismatch is rejected', () =>
{
    const type = new FakeType([Schema.Field('count', 'number', Cardinality.One)])
    assert.ok(Schema.Validator.Validate(type, true, { count: 'not-a-number' }))
})

test('valid create passes', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.One), Schema.Field('count', 'number', Cardinality.Optional)])
    assert.equal(Schema.Validator.Validate(type, true, { title: 'Widget', count: 3 }), undefined)
})

test('user-primitive (base string) accepts a string', () =>
{
    const base = Schema.Primitive('string')
    const slug = Schema.Primitive('slug')
    ;(slug as FakeType).baseType = base
    const type = new FakeType([{ name: 'key', cardinality: Cardinality.One, fieldType: slug }])
    assert.equal(Schema.Validator.Validate(type, true, { key: 'abc' }), undefined)
})

test('undefined concept type is rejected', () =>
{
    assert.ok(Schema.Validator.Validate(undefined, true, { title: 'x' }))
})

test('non-scalar value is rejected', () =>
{
    const type = new FakeType([Schema.Field('title', 'string', Cardinality.One)])
    assert.ok(Schema.Validator.Validate(type, true, { title: { nested: 1 } as unknown as string }))
})
