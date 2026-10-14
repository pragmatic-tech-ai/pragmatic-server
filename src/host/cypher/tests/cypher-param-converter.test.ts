import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CypherParamConverter, CypherParamError } from '../cypher-param-converter.js'

class ParamFixture
{
    public static readonly ProtoJson = '{"__proto__":{"x":1},"ok":2}'
}

test('ToMap converts scalars and null', () =>
{
    const map = CypherParamConverter.ToMap({ s: 'a', n: 1, b: true, z: null })
    assert.deepEqual([...map.entries()], [['s', 'a'], ['n', 1], ['b', true], ['z', null]])
})

test('ToMap round-trips a nested list', () =>
{
    const map = CypherParamConverter.ToMap({ l: [1, ['a', null], [true]] })
    assert.deepEqual(map.get('l'), [1, ['a', null], [true]])
})

test('ToMap round-trips a nested map with keys preserved', () =>
{
    const map = CypherParamConverter.ToMap({ m: { a: 1, inner: { b: 'x', list: [1, 2] } } })
    const value = map.get('m') as Record<string, unknown>
    assert.deepEqual(Object.keys(value), ['a', 'inner'])
    assert.equal(value.a, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(value.inner)), { b: 'x', list: [1, 2] })
})

test('ToMap keeps a __proto__ key as an own property without touching the prototype', () =>
{
    const wire = JSON.parse(ParamFixture.ProtoJson) as { [k: string]: never }
    const map = CypherParamConverter.ToMap({ m: wire })
    const value = map.get('m') as Record<string, unknown>
    assert.ok(Object.prototype.hasOwnProperty.call(value, '__proto__'))
    assert.deepEqual(JSON.parse(JSON.stringify(Object.getOwnPropertyDescriptor(value, '__proto__')!.value)), { x: 1 })
    assert.equal(Object.getPrototypeOf(value), null)
    assert.equal(value.ok, 2)
    assert.equal(({} as Record<string, unknown>).x, undefined)
})

test('ToMap rejects a non-finite number', () =>
{
    assert.throws(() => CypherParamConverter.ToMap({ n: Number.POSITIVE_INFINITY }), CypherParamError)
})
