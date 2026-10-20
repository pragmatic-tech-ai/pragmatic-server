import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphRegistry } from '../graph-registry.js'
import type { GraphRecord } from '../graph-record.js'

class GraphFixture
{
    public static readonly DirPrefix = 'graphreg-'
    public static readonly CreatedAt = '2026-10-20T00:00:00.000Z'

    public static Record(name: string, description: string): GraphRecord
    {
        return { manifest: { name, description, packages: [] }, createdAt: GraphFixture.CreatedAt }
    }
}

test('a graph with an empty manifest round-trips through Put/Load', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), GraphFixture.DirPrefix))
    const file = join(dir, 'graphs.json')
    try
    {
        const first = new GraphRegistry(file)
        await first.Put(GraphFixture.Record('g1', 'first'))
        const second = new GraphRegistry(file)
        await second.Load()
        const got = second.Get('g1')
        assert.ok(got)
        assert.equal(got.manifest.name, 'g1')
        assert.equal(got.manifest.description, 'first')
        assert.ok(Array.isArray(got.manifest.packages) && got.manifest.packages.length === 0)
        assert.equal(got.createdAt, GraphFixture.CreatedAt)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Load on a missing file yields an empty list (no throw)', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), GraphFixture.DirPrefix))
    try
    {
        const reg = new GraphRegistry(join(dir, 'none.json'))
        await reg.Load()
        assert.equal(reg.List().length, 0)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('Remove deletes a graph; it is gone after reload', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), GraphFixture.DirPrefix))
    const file = join(dir, 'graphs.json')
    try
    {
        const first = new GraphRegistry(file)
        await first.Put(GraphFixture.Record('a', 'A'))
        await first.Put(GraphFixture.Record('b', 'B'))
        await first.Remove('a')
        const second = new GraphRegistry(file)
        await second.Load()
        assert.equal(second.List().length, 1)
        assert.equal(second.Get('a'), undefined)
        assert.ok(second.Get('b'))
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

test('persist creates nested directories', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), GraphFixture.DirPrefix))
    const file = join(dir, 'sub', 'graphs.json')
    try
    {
        const first = new GraphRegistry(file)
        await first.Put(GraphFixture.Record('n', 'nested'))
        await access(file)
        const second = new GraphRegistry(file)
        await second.Load()
        assert.ok(second.Get('n'))
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
