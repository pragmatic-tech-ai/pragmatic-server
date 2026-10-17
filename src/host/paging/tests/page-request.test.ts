import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CursorStaleError, ErrorCodes, PageCursorCodec, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PagingLimits } from '../../../config/paging-limits.js'
import { PageFingerprint, PageRequest } from '../page-request.js'

class Fixture
{
    public static readonly Fingerprint = 'fp-a'
    public static readonly OtherFingerprint = 'fp-b'

    public static Limits(): PagingLimits
    {
        return new PagingLimits()
    }

    public static AssertCode(action: () => unknown, code: number): void
    {
        assert.throws(action, (error: unknown) => error instanceof ResponseError && error.code === code)
    }

    public static AssertStale(action: () => unknown): void
    {
        assert.throws(action, (error: unknown) => error instanceof ResponseError && error.code === -32032 && error.message === CursorStaleError.Message)
    }
}

test('a missing pageSize uses the default 500 at offset 0', () =>
{
    const request = PageRequest.Resolve({}, Fixture.Fingerprint, Fixture.Limits())
    assert.equal(request.Size, 500)
    assert.equal(request.Offset, 0)
})

test('a pageSize above the max clamps to 5000', () =>
{
    assert.equal(PageRequest.Resolve({ pageSize: 9000 }, Fixture.Fingerprint, Fixture.Limits()).Size, 5000)
})

test('a cap clamps the size below the max', () =>
{
    assert.equal(PageRequest.Resolve({ pageSize: 9000 }, Fixture.Fingerprint, Fixture.Limits(), 1000).Size, 1000)
    assert.equal(PageRequest.Resolve({}, Fixture.Fingerprint, Fixture.Limits(), 100).Size, 100)
})

test('a pageSize under the max is kept', () =>
{
    assert.equal(PageRequest.Resolve({ pageSize: 42 }, Fixture.Fingerprint, Fixture.Limits()).Size, 42)
})

for (const bad of [0, -1, 2.5])
{
    test(`pageSize ${bad} throws InvalidParams`, () =>
    {
        Fixture.AssertCode(() => PageRequest.Resolve({ pageSize: bad }, Fixture.Fingerprint, Fixture.Limits()), ErrorCodes.InvalidParams)
    })

    test(`ValidatePageSize rejects pageSize ${bad} with InvalidParams`, () =>
    {
        Fixture.AssertCode(() => PageRequest.ValidatePageSize({ pageSize: bad }), ErrorCodes.InvalidParams)
    })
}

test('ValidatePageSize accepts an absent or positive integer pageSize', () =>
{
    PageRequest.ValidatePageSize({})
    PageRequest.ValidatePageSize({ pageSize: 1 })
    PageRequest.ValidatePageSize({ pageSize: 6000 })
})

test('a cursor from another fingerprint throws the stale-cursor error', () =>
{
    const cursor = PageCursorCodec.Encode({ offset: 10, fingerprint: Fixture.OtherFingerprint })
    Fixture.AssertStale(() => PageRequest.Resolve({ cursor }, Fixture.Fingerprint, Fixture.Limits()))
    assert.equal(CursorStaleError.Code, -32032)
})

test('a garbage cursor throws the stale-cursor error', () =>
{
    Fixture.AssertStale(() => PageRequest.Resolve({ cursor: 'not-a-cursor!!' }, Fixture.Fingerprint, Fixture.Limits()))
})

test('a cursor with a negative offset throws the stale-cursor error', () =>
{
    const cursor = Buffer.from(JSON.stringify({ offset: -5, fingerprint: Fixture.Fingerprint })).toString('base64url')
    Fixture.AssertStale(() => PageRequest.Resolve({ cursor }, Fixture.Fingerprint, Fixture.Limits()))
})

test('a matching cursor resumes at its offset', () =>
{
    const cursor = PageCursorCodec.Encode({ offset: 30, fingerprint: Fixture.Fingerprint })
    assert.equal(PageRequest.Resolve({ cursor, pageSize: 10 }, Fixture.Fingerprint, Fixture.Limits()).Offset, 30)
})

test('NextCursor(true) encodes offset + size with the same fingerprint; NextCursor(false) is undefined', () =>
{
    const cursor = PageCursorCodec.Encode({ offset: 20, fingerprint: Fixture.Fingerprint })
    const request = PageRequest.Resolve({ cursor, pageSize: 10 }, Fixture.Fingerprint, Fixture.Limits())
    const next = request.NextCursor(true)
    assert.ok(next !== undefined)
    assert.deepEqual(PageCursorCodec.Decode(next), { offset: 30, fingerprint: Fixture.Fingerprint })
    assert.equal(request.NextCursor(false), undefined)
})

test('PageFingerprint separates parts so a/b differs from ab', () =>
{
    assert.notEqual(PageFingerprint.Of('a', 'b'), PageFingerprint.Of('ab'))
    assert.equal(PageFingerprint.Of('a', 'b'), PageFingerprint.Of('a', 'b'))
    assert.match(PageFingerprint.Of('a'), /^[0-9a-f]{64}$/)
})
