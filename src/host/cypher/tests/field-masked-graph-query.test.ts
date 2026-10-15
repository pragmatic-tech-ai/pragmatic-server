import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FieldMaskedGraphQuery, MaskedMirror, AllowAllFieldReadMask } from '../field-masked-graph-query.js'
import type { IFieldReadMask } from '../field-masked-graph-query.js'

class FakeMirror
{
    constructor(private readonly concept: string, private readonly data: Record<string, string>) {}
    public get type(): unknown { return { fullName: this.concept } }
    public get class(): undefined { return undefined }
    public get node(): unknown { return { id: 'w1', type: this.concept, attrs: { ...this.data } } }
    public field(name: string): unknown { return name in this.data ? { field: { name }, value: this.data[name] } : undefined }
    public fields(): unknown[] { return Object.keys(this.data).map(n => ({ field: { name: n }, value: this.data[n] })) }
}

class FakeGraph
{
    constructor(private readonly mirror: FakeMirror) {}
    public InstancesOf(): unknown[] { return [this.mirror] }
    public Reflect(): unknown { return this.mirror }
    public Refs(): unknown[] { return [] }
    public Referrers(): unknown[] { return [] }
    public Search(): unknown[] { return [] }
    public AllInstances(): unknown[] { return [this.mirror] }
    public Concepts(): unknown[] { return [] }
    public Type(): undefined { return undefined }
    public Term(): undefined { return undefined }
    public Narrower(): unknown[] { return [] }
    public Broader(): unknown[] { return [] }
    public Descendants(): unknown[] { return [] }
    public Ancestors(): unknown[] { return [] }
    public IconKey(): undefined { return undefined }
}

class CostHidden implements IFieldReadMask
{
    public CanRead(_concept: string, field: string): boolean { return field !== 'cost' }
}

test('masked mirror hides a denied field in field(), fields(), and node.attrs', () =>
{
    const inner = new FakeMirror('shop.Widget', { label: 'W', cost: '99' }) as never
    const masked = new MaskedMirror(inner, new CostHidden())
    assert.equal(masked.field('cost'), undefined)
    assert.equal((masked.field('label') as { value: string }).value, 'W')
    assert.deepEqual(masked.fields().map(f => f.field.name), ['label'])
    assert.equal((masked.node.attrs as Record<string, string>).cost, undefined)
    assert.equal((masked.node.attrs as Record<string, string>).label, 'W')
})

test('FieldMaskedGraphQuery wraps every returned mirror', () =>
{
    const graph = new FakeGraph(new FakeMirror('shop.Widget', { label: 'W', cost: '99' })) as never
    const masked = new FieldMaskedGraphQuery(graph, new CostHidden())
    assert.equal(masked.Reflect('w1')?.field('cost'), undefined)
    assert.equal(masked.InstancesOf('shop.Widget')[0].field('cost'), undefined)
    assert.equal(masked.AllInstances()[0].field('label')?.value, 'W')
})

test('allow-all mask returns every field unchanged', () =>
{
    const inner = new FakeMirror('shop.Widget', { cost: '99' }) as never
    const masked = new MaskedMirror(inner, AllowAllFieldReadMask.Instance)
    assert.equal((masked.field('cost') as { value: string }).value, '99')
})
