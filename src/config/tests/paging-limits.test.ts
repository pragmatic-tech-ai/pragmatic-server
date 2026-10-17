import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PagingLimits } from '../paging-limits.js'

test('PagingLimits defaults to 500 and a max of 5000', () =>
{
    const limits = new PagingLimits()
    assert.equal(PagingLimits.DefaultPageSize, 500)
    assert.equal(PagingLimits.DefaultMaxPageSize, 5000)
    assert.equal(limits.PageSize, 500)
    assert.equal(limits.MaxPageSize, 5000)
})

test('PagingLimits keeps explicit values', () =>
{
    const limits = new PagingLimits(100, 200)
    assert.equal(limits.PageSize, 100)
    assert.equal(limits.MaxPageSize, 200)
})

test('PagingLimits throws when the default page size exceeds the max', () =>
{
    assert.throws(() => new PagingLimits(6000, 5000), /PRAGMATIC_PAGE_SIZE_DEFAULT/)
})

test('PagingLimits throws when only the max is lowered below the default', () =>
{
    assert.throws(() => new PagingLimits(undefined, 100), /PRAGMATIC_PAGE_SIZE_DEFAULT/)
})
