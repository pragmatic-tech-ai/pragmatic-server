import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IStorage, StorageEntry } from '@pragmatic-tech-ai/todl-runtime'
import { DevGraphStore, type DevGraphRecord } from '../dev-graph-store.js'

class MemoryStorage implements IStorage
{
    public readonly Root = 'mem'
    public readonly Files = new Map<string, string>()

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
    public async Rename(from: string, to: string): Promise<void> { this.Files.set(to, await this.ReadText(from)); this.Files.delete(from) }
    public async List(): Promise<readonly StorageEntry[]> { return [] }
}

class Fixture
{
    public static Record(name: string, description: string): DevGraphRecord
    {
        return { name, description, packages: [], createdAt: '2026-10-20T00:00:00.000Z' }
    }

    public static async Reload(storage: IStorage): Promise<DevGraphStore>
    {
        const store = new DevGraphStore(storage)
        await store.Load()
        return store
    }
}

test('a graph with an empty package list round-trips through Put/Load', async () =>
{
    const storage = new MemoryStorage()
    await new DevGraphStore(storage).Put(Fixture.Record('g1', 'first'))
    const reloaded = await Fixture.Reload(storage)
    const got = reloaded.Get('g1')
    assert.equal(got?.name, 'g1')
    assert.equal(got?.description, 'first')
    assert.ok(Array.isArray(got?.packages) && got.packages.length === 0)
})

test('Load on empty storage yields an empty list', async () =>
{
    const store = await Fixture.Reload(new MemoryStorage())
    assert.equal(store.List().length, 0)
})

test('Remove deletes a graph; it is gone after reload', async () =>
{
    const storage = new MemoryStorage()
    const store = new DevGraphStore(storage)
    await store.Put(Fixture.Record('a', 'A'))
    await store.Put(Fixture.Record('b', 'B'))
    await store.Remove('a')
    const reloaded = await Fixture.Reload(storage)
    assert.deepEqual(reloaded.List().map(r => r.name), ['b'])
    assert.equal(reloaded.Get('a'), undefined)
})
