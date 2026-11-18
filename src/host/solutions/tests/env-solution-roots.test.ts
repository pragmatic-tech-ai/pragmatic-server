import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import { EnvSolutionRoots, InvalidSolutionNameError } from '../env-solution-roots.js'

class FakeRegistry implements IStorageProviderRegistry
{
    public readonly Created: string[] = []
    private readonly stores = new Map<string, FakeStorage>()

    public CreateStorage(location: string): IStorage
    {
        this.Created.push(location)
        let store = this.stores.get(location)
        if (store === undefined)
        {
            store = new FakeStorage(location)
            this.stores.set(location, store)
        }
        return store
    }
}

class RootsFx
{
    public static readonly Area = 'env/src'
    public static readonly BadNames = ['', '.', '..', 'a/b', 'a\\b', '/abs', '\\abs', 'C:x', 'c:', 'a..b', 'x\u0000y', 'a:b', '../escape', 'trail.', 'trail ', ' lead', 'new\nline', 'tab\tx', 'CON', 'con', 'Nul', 'COM1', 'lpt9', 'aux.txt', '\u007f']

    public static Make(): { roots: EnvSolutionRoots, registry: FakeRegistry }
    {
        const registry = new FakeRegistry()
        return { roots: new EnvSolutionRoots(RootsFx.Area, registry), registry }
    }

    public static Manifest(name: string, members: { path: string, type: string }[]): string
    {
        return JSON.stringify({ kind: 'todl-solution', version: 1, name, members, settings: {} })
    }

    /** Lays a solution folder (manifest) into the fake area so Refresh can discover it. */
    public static async Seed(registry: FakeRegistry, name: string, members: { path: string, type: string }[]): Promise<void>
    {
        const store = registry.CreateStorage(`${RootsFx.Area}/${name}`)
        await store.WriteText(`${name}.pksln`, RootsFx.Manifest(name, members))
        await registry.CreateStorage(RootsFx.Area).CreateDirectory(name)
    }
}

test('EnsureRoot creates a distinct root per solution name', async () =>
{
    const { roots } = RootsFx.Make()
    const a = roots.EnsureRoot('Alpha')
    const b = roots.EnsureRoot('Beta')
    await a.WriteText('f.txt', 'A')
    assert.equal(await b.Exists('f.txt'), false)
    assert.notEqual(a, b)
    assert.equal(roots.RootFor('Alpha'), a)
    assert.deepEqual([...roots.Names()].sort(), ['Alpha', 'Beta'])
})

test('RootFor throws on an unknown solution', () =>
{
    const { roots } = RootsFx.Make()
    assert.throws(() => roots.RootFor('Nope'), (e: unknown) => e instanceof Error && e.name === 'UnknownSolutionRootError')
})

test('invalid solution names are rejected by RootFor and EnsureRoot and never reach the registry', () =>
{
    const { roots, registry } = RootsFx.Make()
    for (const bad of RootsFx.BadNames)
    {
        assert.throws(() => roots.EnsureRoot(bad), (e: unknown) => e instanceof InvalidSolutionNameError, JSON.stringify(bad))
        assert.throws(() => roots.RootFor(bad), (e: unknown) => e instanceof InvalidSolutionNameError, JSON.stringify(bad))
    }
    assert.deepEqual(registry.Created, [])
})

test('Refresh discovers solution folders, MembersOf reads manifest read-only, Changed fires', async () =>
{
    const { roots, registry } = RootsFx.Make()
    await RootsFx.Seed(registry, 'Gamma', [{ path: 'proj1', type: 'todl' }, { path: 'proj2', type: 'todl' }])
    let changes = 0
    roots.Changed.subscribe(() => { changes++ })
    await roots.Refresh()
    assert.deepEqual(roots.Names(), ['Gamma'])
    assert.equal(changes, 1)
    const members = roots.MembersOf('Gamma')
    assert.deepEqual(members.map(m => m.Ref.path), ['proj1', 'proj2'])
    assert.equal(members[0].Ref.type, 'todl')
    await roots.Refresh()
    assert.equal(changes, 1)
    assert.deepEqual(roots.MembersOf('Unknown'), [])
})

test('MembersOf skips members whose path is a drive path or climbs out of the solution folder', async () =>
{
    const { roots, registry } = RootsFx.Make()
    await RootsFx.Seed(registry, 'Evil', [{ path: '../Other', type: 't' }, { path: 'C:/x', type: 't' }, { path: 'proj:stream', type: 't' }, { path: 'a/b:c', type: 't' }, { path: 'nl\nx', type: 't' }, { path: '.. /x', type: 't' }, { path: 'a/.../x', type: 't' }, { path: 'ok', type: 't' }])
    await roots.Refresh()
    assert.deepEqual(roots.MembersOf('Evil').map(m => m.Ref.path), ['ok'])
})

test('EnsureRoot of a new name fires Changed once; repeat does not', () =>
{
    const { roots } = RootsFx.Make()
    let changes = 0
    roots.Changed.subscribe(() => { changes++ })
    roots.EnsureRoot('N')
    roots.EnsureRoot('N')
    assert.equal(changes, 1)
})

test('Refresh prunes a discovered solution that vanished, but keeps an ensured-not-yet-written one', async () =>
{
    const { roots, registry } = RootsFx.Make()
    await RootsFx.Seed(registry, 'Gone', [])
    roots.EnsureRoot('Pending')
    await roots.Refresh()
    assert.deepEqual([...roots.Names()].sort(), ['Gone', 'Pending'])
    const area = registry.CreateStorage(RootsFx.Area)
    await area.Delete('Gone')
    let changes = 0
    roots.Changed.subscribe(() => { changes++ })
    await roots.Refresh()
    assert.deepEqual(roots.Names(), ['Pending'])
    assert.deepEqual(roots.MembersOf('Gone'), [])
    assert.equal(changes, 1)
})

test('a non-not-found I/O error during Refresh propagates and does not empty the solution', async () =>
{
    const { roots, registry } = RootsFx.Make()
    await RootsFx.Seed(registry, 'Flaky', [{ path: 'p', type: 't' }])
    await roots.Refresh()
    const store = registry.CreateStorage(RootsFx.Area + '/Flaky')
    store.ReadText = () => Promise.reject(new Error('EIO: transient'))
    await assert.rejects(() => roots.Refresh(), /EIO/)
    assert.deepEqual(roots.MembersOf('Flaky').map(m => m.Ref.path), ['p'])
})

test('Refresh on a source area that does not exist yet yields empty without throwing', async () =>
{
    const { roots } = RootsFx.Make()
    await roots.Refresh()
    assert.deepEqual(roots.Names(), [])
})

test('a not-found List error is tolerated but a genuine I/O error propagates', async () =>
{
    const { roots, registry } = RootsFx.Make()
    const area = registry.CreateStorage(RootsFx.Area)
    area.List = () => Promise.reject(new Error('ENOENT: no such dir'))
    await roots.Refresh()
    assert.deepEqual(roots.Names(), [])
    area.List = () => Promise.reject(new Error('EIO: bad disk'))
    await assert.rejects(() => roots.Refresh(), /EIO/)
})
