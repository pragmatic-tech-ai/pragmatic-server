import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConnectorFilterOp, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import { QueryCompareOp, WriteAtomicity, WriteConcurrency } from '@pragmatic-tech-ai/todl'
import type { ConnectorBinding } from '@pragmatic-tech-ai/todl'
import { ConnectorReadFilter } from '../connector-read-filter.js'

class ReadFilterFixture
{
    public static readonly Binding: ConnectorBinding = {
        Concept: 'shop.Customer', Connector: 'pg', Source: 'customers', IdKey: 'cid',
        FieldMap: { id: 'cid', region: 'REGION', salary: 'SALARY' }, Writable: false,
        Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
    }

    public static readonly HideSalary = { CanRead: (_concept: string, field: string) => field !== 'salary' }

    public static Message(attempt: () => unknown): string
    {
        try
        {
            attempt()
        }
        catch (error)
        {
            assert.equal((error as { code?: number }).code, ErrorCodes.InvalidParams)
            return (error as Error).message.replace(/: \w+$/, '')
        }
        throw new Error('expected a refusal')
    }
}

test('terms translate to external names, the id member to the id column', () =>
{
    const where = ConnectorReadFilter.For(ReadFilterFixture.Binding, [
        { field: 'region', op: ConnectorFilterOp.In, values: ['eu'] },
        { field: 'id', op: ConnectorFilterOp.Eq, value: 'C1' },
        { field: 'region', op: ConnectorFilterOp.IsNotNull },
    ], undefined)
    assert.deepEqual(where, { All: [
        { Field: 'REGION', Op: QueryCompareOp.In, Value: null, Values: ['eu'] },
        { Field: 'cid', Op: QueryCompareOp.Eq, Value: 'C1' },
        { Field: 'REGION', Op: QueryCompareOp.IsNotNull, Value: null },
    ] })
})

test('a field-masked member is refused exactly like an unknown one (no oracle)', () =>
{
    const masked = ReadFilterFixture.Message(() => ConnectorReadFilter.For(ReadFilterFixture.Binding, [{ field: 'salary', op: ConnectorFilterOp.Gt, value: 1 }], ReadFilterFixture.HideSalary))
    const unknown = ReadFilterFixture.Message(() => ConnectorReadFilter.For(ReadFilterFixture.Binding, [{ field: 'bonus', op: ConnectorFilterOp.Gt, value: 1 }], ReadFilterFixture.HideSalary))
    assert.equal(masked, unknown)
})

test('no terms means no filter, and the canonical form distinguishes filters', () =>
{
    assert.equal(ConnectorReadFilter.For(ReadFilterFixture.Binding, undefined, undefined), undefined)
    assert.equal(ConnectorReadFilter.For(ReadFilterFixture.Binding, [], undefined), undefined)
    const a = ConnectorReadFilter.For(ReadFilterFixture.Binding, [{ field: 'region', op: ConnectorFilterOp.Eq, value: 'eu' }], undefined)
    const b = ConnectorReadFilter.For(ReadFilterFixture.Binding, [{ field: 'region', op: ConnectorFilterOp.Eq, value: 'us' }], undefined)
    assert.notEqual(ConnectorReadFilter.Canonical(a), ConnectorReadFilter.Canonical(b))
    assert.equal(ConnectorReadFilter.Canonical(undefined), '')
})

test('a malformed term on a masked field fails exactly like one on an unknown field (no oracle through operand errors)', () =>
{
    const masked = ReadFilterFixture.Message(() => ConnectorReadFilter.For(ReadFilterFixture.Binding, [{ field: 'salary', op: ConnectorFilterOp.Eq, value: {} as never }], ReadFilterFixture.HideSalary))
    const unknown = ReadFilterFixture.Message(() => ConnectorReadFilter.For(ReadFilterFixture.Binding, [{ field: 'nosuch', op: ConnectorFilterOp.Eq, value: {} as never }], ReadFilterFixture.HideSalary))
    assert.equal(masked, unknown)
    const badIn = ReadFilterFixture.Message(() => ConnectorReadFilter.For(ReadFilterFixture.Binding, [{ field: 'salary', op: ConnectorFilterOp.In, values: 'x' as never }], ReadFilterFixture.HideSalary))
    assert.equal(badIn, unknown)
    const badOp = ReadFilterFixture.Message(() => ConnectorReadFilter.For(ReadFilterFixture.Binding, [{ field: 'salary', op: 'like' as ConnectorFilterOp, value: 1 }], ReadFilterFixture.HideSalary))
    assert.equal(badOp, unknown)
})
