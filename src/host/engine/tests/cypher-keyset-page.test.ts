import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cypher } from '@pragmatic-tech-ai/graph'
import { CursorStaleError, PageCursorCodec, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PagingLimits } from '../../../config/paging-limits.js'
import { CypherKeysetPage } from '../cypher-keyset-page.js'

class KeysetFx
{
    public static readonly Fingerprint = 'fp-a'
    public static readonly OtherFingerprint = 'fp-b'
    public static readonly Column = 'l'
    public static readonly Separator = '\u0000'
    public static readonly Garbage = 'not-a-cypher-cursor'

    public static Limits(): PagingLimits
    {
        return new PagingLimits()
    }

    public static Cursor(label: string): Cypher.CypherCursor
    {
        return new Cypher.CypherCursor(7n, [new Cypher.ScalarValue(label)])
    }

    /** A page result with one row per label and the given engine cursor. */
    public static Result(labels: readonly string[], hasMore: boolean, next?: Cypher.CypherCursor): Cypher.CypherResult
    {
        return new Cypher.CypherResult([KeysetFx.Column], labels.map(label => [new Cypher.ScalarValue(label)]), false, hasMore, undefined, undefined, next)
    }

    public static AssertStale(action: () => unknown): void
    {
        assert.throws(action, (error: unknown) => error instanceof ResponseError && error.code === CursorStaleError.Code)
    }
}

test('cursor round-trips (first page uses skip zero)', () =>
{
    const first = CypherKeysetPage.Resolve({ pageSize: 2 }, KeysetFx.Fingerprint, KeysetFx.Limits())
    assert.deepEqual(first.Limits(), { Skip: 0, RowCap: 2 }, 'the first page is a Skip-0 page, never RowCap alone')
    const engineCursor = KeysetFx.Cursor('b')
    const wire = first.NextCursor(KeysetFx.Result(['a', 'b'], true, engineCursor))
    assert.ok(wire !== undefined)
    const second = CypherKeysetPage.Resolve({ pageSize: 2, cursor: wire }, KeysetFx.Fingerprint, KeysetFx.Limits())
    assert.equal(second.After!.Encode(), engineCursor.Encode())
    assert.equal(second.Offset, 0)
    const limits = second.Limits()
    assert.equal(limits.Skip, undefined, 'never both After and Skip')
    assert.equal(limits.RowCap, 2)
    assert.equal(second.NextCursor(KeysetFx.Result(['c'], false)), undefined, 'the last page has no cursor')
})

test('foreign fingerprint is stale', () =>
{
    const wire = CypherKeysetPage.Resolve({}, KeysetFx.Fingerprint, KeysetFx.Limits()).NextCursor(KeysetFx.Result(['a'], true, KeysetFx.Cursor('a')))!
    KeysetFx.AssertStale(() => CypherKeysetPage.Resolve({ cursor: wire }, KeysetFx.OtherFingerprint, KeysetFx.Limits()))
    const offsetWire = CypherKeysetPage.Resolve({}, KeysetFx.Fingerprint, KeysetFx.Limits()).NextCursor(KeysetFx.Result(['a'], true))!
    KeysetFx.AssertStale(() => CypherKeysetPage.Resolve({ cursor: offsetWire }, KeysetFx.OtherFingerprint, KeysetFx.Limits()))
})

test('garbage cursor is stale', () =>
{
    const undecodable = PageCursorCodec.Encode({ offset: 0, fingerprint: `${KeysetFx.Fingerprint}${KeysetFx.Separator}${KeysetFx.Garbage}` })
    assert.throws(() => Cypher.CypherCursor.Decode(KeysetFx.Garbage), 'the engine rejects the embedded cursor')
    KeysetFx.AssertStale(() => CypherKeysetPage.Resolve({ cursor: undecodable }, KeysetFx.Fingerprint, KeysetFx.Limits()))
    KeysetFx.AssertStale(() => CypherKeysetPage.Resolve({ cursor: KeysetFx.Garbage }, KeysetFx.Fingerprint, KeysetFx.Limits()))
})
