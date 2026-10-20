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
    public async Rename(from: string, to: string): Promise<void>
    {
        this.Files.set(to, await this.ReadText(from))
        this.Files.delete(from)
    }
    public async List(): Promise<readonly StorageEntry[]> { return [] }
}

class Fixture
{
    public static Record(name: string, description: string): DevGraphRecord
    {
        return { name, description, slices: {}, createdAt: '2026-10-20T00:00:00.000Z' }
    }

    public static async Reload(storage: IStorage): Promise<DevGraphStore>
    {
        const store = new DevGraphStore(storage)
        await store.Load()
        return store
    }
}

test('a graph with no slices round-trips through Put/Load', async () =>
{
    const storage = new MemoryStorage()
    await new DevGraphStore(storage).Put(Fixture.Record('g1', 'first'))
    const reloaded = await Fixture.Reload(storage)
    const got = reloaded.Get('g1')
    assert.equal(got?.name, 'g1')
    assert.equal(got?.description, 'first')
    assert.deepEqual(got?.slices, {})
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

test('mutating a returned record does not change stored state', async () =>
{
    const storage = new MemoryStorage()
    const store = new DevGraphStore(storage)
    await store.Put({ ...Fixture.Record('g', 'd'), slices: { s1: [{ id: 'a', version: '1' }] } })
    const got = store.Get('g')
    got?.slices.s1.push({ id: 'x', version: '1' })
    if (got !== undefined) got.slices.s1[0].version = '99'
    store.List()[0].slices.s2 = []
    assert.deepEqual(store.Get('g')?.slices, { s1: [{ id: 'a', version: '1' }] })
    assert.deepEqual((await Fixture.Reload(storage)).Get('g')?.slices, { s1: [{ id: 'a', version: '1' }] })
})

test('a record with two slices persists and reloads intact', async () =>
{
    const storage = new MemoryStorage()
    const slices = { s1: [{ id: 'a', version: '1' }], s2: [{ id: 'b', version: '2' }, { id: 'c', version: '3' }] }
    await new DevGraphStore(storage).Put({ ...Fixture.Record('g', 'd'), slices })
    assert.deepEqual((await Fixture.Reload(storage)).Get('g')?.slices, slices)
})

test('an empty slice round-trips as an empty array', async () =>
{
    const storage = new MemoryStorage()
    await new DevGraphStore(storage).Put({ ...Fixture.Record('g', 'd'), slices: { s1: [] } })
    assert.deepEqual((await Fixture.Reload(storage)).Get('g')?.slices, { s1: [] })
})

test('Load on an entry without a slices key yields empty slices and ignores legacy packages', async () =>
{
    const storage = new MemoryStorage()
    storage.Files.set('graphs.json', JSON.stringify({ graphs: { g: { name: 'g', description: 'd', packages: [{ id: 'a', version: '1' }], createdAt: 't' } } }))
    const got = (await Fixture.Reload(storage)).Get('g')
    assert.deepEqual(got?.slices, {})
    assert.equal('packages' in (got ?? {}), false)
})
