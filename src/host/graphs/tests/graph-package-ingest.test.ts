import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IStorage, StorageEntry } from '@pragmatic-tech-ai/todl-runtime'
import type { ContributedPackageDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { GraphPackageConflictError, GraphPackageIngest, GraphPackageSegmentError } from '../graph-package-ingest.js'

class MemoryStorage implements IStorage
{
    public readonly Root = 'mem'
    public readonly Files = new Map<string, string>()
    public FailRenameOf: string | undefined

    public async ReadText(path: string): Promise<string>
    {
        const text = this.Files.get(path)
        if (text === undefined) throw new Error('missing ' + path)
        return text
    }
    public async ReadBytes(path: string): Promise<Uint8Array> { return new TextEncoder().encode(await this.ReadText(path)) }
    public async WriteText(path: string, content: string): Promise<void> { this.Files.set(path, content) }
    public async WriteBytes(path: string, bytes: Uint8Array): Promise<void> { this.Files.set(path, new TextDecoder().decode(bytes)) }
    public async Exists(path: string): Promise<boolean> { return this.Files.has(path) }
    public async Delete(path: string): Promise<void> { this.Files.delete(path) }
    public async CreateDirectory(): Promise<void> {}
    public async Rename(from: string, to: string): Promise<void>
    {
        if (this.FailRenameOf !== undefined && to === this.FailRenameOf) throw new Error('rename failed')
        this.Files.set(to, await this.ReadText(from))
        this.Files.delete(from)
    }
    public async List(): Promise<readonly StorageEntry[]> { return [] }
}

class Fixture
{
    public static Pkg(id: string, version: string, modelJson: string): ContributedPackageDto
    {
        return { id, version, modelJson }
    }
}

test('stores a new package at <id>/<version>/model.json', async () =>
{
    const storage = new MemoryStorage()
    await new GraphPackageIngest(storage).Store([Fixture.Pkg('a', '1.0.0', '{"x":1}')])
    assert.deepEqual([...storage.Files.keys()], ['a/1.0.0/model.json'])
    assert.equal(storage.Files.get('a/1.0.0/model.json'), '{"x":1}')
})

test('identical bytes for an existing id@version are an idempotent no-op', async () =>
{
    const storage = new MemoryStorage()
    const ingest = new GraphPackageIngest(storage)
    await ingest.Store([Fixture.Pkg('a', '1.0.0', '{"x":1}')])
    await ingest.Store([Fixture.Pkg('a', '1.0.0', '{"x":1}')])
    assert.deepEqual([...storage.Files.keys()], ['a/1.0.0/model.json'])
    assert.equal(storage.Files.get('a/1.0.0/model.json'), '{"x":1}')
})

test('differing bytes overwrite the existing version (dev last-writer-wins) and the rest of the batch is written', async () =>
{
    const storage = new MemoryStorage()
    const ingest = new GraphPackageIngest(storage)
    await ingest.Store([Fixture.Pkg('a', '1.0.0', '{"x":1}')])
    await ingest.Store([Fixture.Pkg('b', '1.0.0', '{"y":1}'), Fixture.Pkg('a', '1.0.0', '{"x":2}'), Fixture.Pkg('c', '1.0.0', '{}')])
    assert.deepEqual([...storage.Files.keys()].sort(), ['a/1.0.0/model.json', 'b/1.0.0/model.json', 'c/1.0.0/model.json'])
    assert.equal(storage.Files.get('a/1.0.0/model.json'), '{"x":2}')
    assert.equal(storage.Files.get('b/1.0.0/model.json'), '{"y":1}')
})

test('a mid-commit failure removes newly created paths but leaves a pre-existing version it overwrote in place', async () =>
{
    const storage = new MemoryStorage()
    const ingest = new GraphPackageIngest(storage)
    await ingest.Store([Fixture.Pkg('a', '1.0.0', '{"x":1}')])
    storage.FailRenameOf = 'c/1.0.0/model.json'
    await assert.rejects(
        ingest.Store([Fixture.Pkg('a', '1.0.0', '{"x":2}'), Fixture.Pkg('c', '1.0.0', '{}')]),
        /rename failed/)
    // `a` pre-existed, so it is never deleted (it now carries the overwritten bytes); `c` was new, so it is gone.
    assert.deepEqual([...storage.Files.keys()], ['a/1.0.0/model.json'])
    assert.equal(storage.Files.get('a/1.0.0/model.json'), '{"x":2}')
})

test('the same id@version twice in one batch with different bytes conflicts and writes nothing', async () =>
{
    const storage = new MemoryStorage()
    await assert.rejects(
        new GraphPackageIngest(storage).Store([Fixture.Pkg('a', '1.0.0', '1'), Fixture.Pkg('a', '1.0.0', '2')]),
        GraphPackageConflictError)
    assert.equal(storage.Files.size, 0)
})

test('a mid-commit failure removes temps and newly created files but keeps pre-existing ones', async () =>
{
    const storage = new MemoryStorage()
    const ingest = new GraphPackageIngest(storage)
    await ingest.Store([Fixture.Pkg('keep', '1.0.0', 'k')])
    storage.FailRenameOf = 'c/1.0.0/model.json'
    await assert.rejects(
        ingest.Store([Fixture.Pkg('b', '1.0.0', 'b'), Fixture.Pkg('keep', '1.0.0', 'k'), Fixture.Pkg('c', '1.0.0', 'c')]),
        /rename failed/)
    assert.deepEqual([...storage.Files.keys()], ['keep/1.0.0/model.json'])
    assert.equal(storage.Files.get('keep/1.0.0/model.json'), 'k')
})

class BadSegments
{
    public static readonly Values = ['..', '../x', '', 'a/b', '\u0000']
}

for (const bad of BadSegments.Values)
{
    test(`an invalid package id ${JSON.stringify(bad)} rejects the whole batch with nothing written`, async () =>
    {
        const storage = new MemoryStorage()
        await assert.rejects(
            new GraphPackageIngest(storage).Store([Fixture.Pkg('ok', '1.0.0', '{}'), Fixture.Pkg(bad, '1.0.0', '{}')]),
            GraphPackageSegmentError)
        assert.equal(storage.Files.size, 0)
    })

    test(`an invalid package version ${JSON.stringify(bad)} rejects the whole batch with nothing written`, async () =>
    {
        const storage = new MemoryStorage()
        await assert.rejects(
            new GraphPackageIngest(storage).Store([Fixture.Pkg('ok', '1.0.0', '{}'), Fixture.Pkg('b', bad, '{}')]),
            GraphPackageSegmentError)
        assert.equal(storage.Files.size, 0)
    })
}
