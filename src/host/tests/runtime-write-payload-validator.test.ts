import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemberKind, ValueType } from '@pragmatic-tech-ai/graph'
import { Cardinality } from '@pragmatic-tech-ai/todl'
import { EngineSchemaCatalog } from '../engine/engine-schema-catalog.js'
import { RuntimeWritePayloadValidator } from '../runtime-write-payload-validator.js'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'

/** The slice of a TODL reflected type the required check reads: its fields' names and cardinalities. */
class FakeType
{
    constructor(private readonly fields: { name: string; cardinality: Cardinality }[]) {}
    public getFields(): { name: string; cardinality: Cardinality }[]
    {
        return this.fields
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
}

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
    /** The TODL reflected types: shop.Order's `title` is required (cardinality One). */
    public static readonly Type = { getType: () => new FakeType([{ name: 'title', cardinality: Cardinality.One }, { name: 'count', cardinality: Cardinality.Optional }]) } as unknown as IEnvironmentCatalog['Snapshot']
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
