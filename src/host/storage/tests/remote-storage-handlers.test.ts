import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import { RemoteStorageHandlers } from '../remote-storage-handlers.js'
import { AuthoringStorageResolver } from '../authoring-storage-resolver.js'
import { AuthoringTarget } from '../../solutions/authoring-target.js'
import { EnvSolutionRoots } from '../../solutions/env-solution-roots.js'
import { SolutionManifestRefresher } from '../../solutions/solution-manifest-refresher.js'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { SourceChangeBridge } from '../../solutions/source-change-bridge.js'

class StorageFx
{
    public static readonly Binary = new Uint8Array([0, 1, 2, 127, 128, 200, 254, 255, 0xc3, 0x28])

    public static Handlers(storage: FakeStorage = new FakeStorage()): RemoteStorageHandlers
    {
        return new RemoteStorageHandlers(() => storage)
    }

    public static async Rejects(action: () => Promise<unknown>): Promise<void>
    {
        await assert.rejects(action, (error: unknown) => error instanceof ResponseError && error.code === ErrorCodes.InvalidParams)
    }
}

test('WriteBytes then ReadBytes is byte-exact', async () =>
{
    const handlers = StorageFx.Handlers()
    await handlers.WriteBytes({ Path: 'a/bin.dat', BytesBase64: Buffer.from(StorageFx.Binary).toString('base64') })
    const result = await handlers.ReadBytes({ Path: 'a/bin.dat' })
    assert.deepEqual(new Uint8Array(Buffer.from(result.BytesBase64, 'base64')), StorageFx.Binary)
})

test('WriteText and ReadText round-trip non-ASCII', async () =>
{
    const handlers = StorageFx.Handlers()
    await handlers.WriteText({ Path: 'x.todl', Content: 'caf\u00e9 \u2603' })
    assert.deepEqual(await handlers.ReadText({ Path: 'x.todl' }), { Content: 'caf\u00e9 \u2603' })
})

test('Exists, Delete', async () =>
{
    const handlers = StorageFx.Handlers()
    await handlers.WriteText({ Path: 'x.todl', Content: 'a' })
    assert.equal(await handlers.Exists({ Path: 'x.todl' }), true)
    await handlers.Delete({ Path: 'x.todl' })
    assert.equal(await handlers.Exists({ Path: 'x.todl' }), false)
})

test('CreateDirectory and Rename', async () =>
{
    const handlers = StorageFx.Handlers()
    await handlers.CreateDirectory({ Path: 'd' })
    assert.equal(await handlers.Exists({ Path: 'd' }), true)
    await handlers.WriteText({ Path: 'd/a.txt', Content: 'hi' })
    await handlers.Rename({ From: 'd/a.txt', To: 'd/b.txt' })
    assert.equal(await handlers.Exists({ Path: 'd/a.txt' }), false)
    assert.equal((await handlers.ReadText({ Path: 'd/b.txt' })).Content, 'hi')
})

test('List returns entries with IsDirectory', async () =>
{
    const handlers = StorageFx.Handlers()
    await handlers.CreateDirectory({ Path: 'root/sub' })
    await handlers.WriteText({ Path: 'root/file.txt', Content: 'f' })
    const entries = [...await handlers.List({ Path: 'root' })].sort((a, b) => a.Name.localeCompare(b.Name))
    assert.deepEqual(entries, [{ Name: 'file.txt', IsDirectory: false }, { Name: 'sub', IsDirectory: true }])
})

test('paths are resolved under the root: dot segments and backslashes normalize', async () =>
{
    const storage = new FakeStorage()
    const handlers = StorageFx.Handlers(storage)
    await handlers.WriteText({ Path: 'a/./b/../c.txt', Content: 'n' })
    assert.equal(await storage.Exists('a/c.txt'), true)
})

test('path escapes and absolute paths are rejected', async () =>
{
    const handlers = StorageFx.Handlers()
    await StorageFx.Rejects(() => handlers.ReadText({ Path: '../outside' }))
    await StorageFx.Rejects(() => handlers.ReadText({ Path: 'a/../../outside' }))
    await StorageFx.Rejects(() => handlers.WriteText({ Path: '..\\outside', Content: 'x' }))
    await StorageFx.Rejects(() => handlers.Exists({ Path: '/etc/passwd' }))
    await StorageFx.Rejects(() => handlers.Delete({ Path: 'C:\\Windows' }))
    await StorageFx.Rejects(() => handlers.Rename({ From: 'a', To: '../b' }))
    await StorageFx.Rejects(() => handlers.List({ Path: '//server/share' }))
})

test('Windows trailing-dot/space segments that strip to a dot segment are rejected before storage is touched', async () =>
{
    const storage = new FakeStorage()
    await storage.WriteText('keep.txt', 'k')
    const handlers = StorageFx.Handlers(storage)
    // `.. ` (dot-dot-space) and `..`+trailing-dot (`...`) both normalize to `..` / empty once Windows drops the trailing
    // run, so each would climb out of the root; `.. /x` is the same escape with a trailing name. All must be refused.
    for (const path of ['.. ', '...', '.. /x', 'a/.. /b', 'a/.../b', '. ', 'a/. /b'])
    {
        await StorageFx.Rejects(() => handlers.ReadText({ Path: path }))
        await StorageFx.Rejects(() => handlers.WriteText({ Path: path, Content: 'x' }))
        await StorageFx.Rejects(() => handlers.Delete({ Path: path }))
    }
    assert.equal(await storage.Exists('keep.txt'), true)
    assert.equal(storage.size, 1)
})

test('segments carrying the full control-char range (not just NUL) are rejected', async () =>
{
    const handlers = StorageFx.Handlers()
    for (const control of ['\u0001', '\u001f', '\u007f'])
    {
        await StorageFx.Rejects(() => handlers.ReadText({ Path: 'a/b' + control + 'c' }))
    }
})

test('no active source storage is rejected', async () =>
{
    const handlers = new RemoteStorageHandlers(() => undefined)
    await assert.rejects(() => handlers.Exists({ Path: 'a' }), (error: unknown) => error instanceof ResponseError && error.code === ErrorCodes.InvalidRequest)
})

test('backslash separators normalize to the same path as forward slashes', async () =>
{
    const storage = new FakeStorage()
    const handlers = StorageFx.Handlers(storage)
    await handlers.WriteText({ Path: 'a\\b/c.txt', Content: 'n' })
    assert.equal(await storage.Exists('a/b/c.txt'), true)
})

test('drive letter without a slash and unsafe segments are rejected', async () =>
{
    const handlers = StorageFx.Handlers()
    await StorageFx.Rejects(() => handlers.ReadText({ Path: 'C:foo' }))
    await StorageFx.Rejects(() => handlers.ReadText({ Path: 'a/C:x' }))
    await StorageFx.Rejects(() => handlers.ReadText({ Path: 'a/b:stream' }))
    await StorageFx.Rejects(() => handlers.ReadText({ Path: 'a/b\0c' }))
})

test('destructive operations on the root are rejected (empty, dot, a/..)', async () =>
{
    const storage = new FakeStorage()
    await storage.WriteText('keep.txt', 'k')
    const handlers = StorageFx.Handlers(storage)
    for (const path of ['', '.', 'a/..'])
    {
        await StorageFx.Rejects(() => handlers.Delete({ Path: path }))
        await StorageFx.Rejects(() => handlers.WriteText({ Path: path, Content: 'x' }))
        await StorageFx.Rejects(() => handlers.WriteBytes({ Path: path, BytesBase64: '' }))
        await StorageFx.Rejects(() => handlers.Rename({ From: path, To: 'b' }))
        await StorageFx.Rejects(() => handlers.Rename({ From: 'b', To: path }))
    }
    assert.equal(await storage.Exists('keep.txt'), true)
})

test('read-only and harmless operations on the root are allowed', async () =>
{
    const handlers = StorageFx.Handlers()
    await handlers.CreateDirectory({ Path: '.' })
    assert.deepEqual(await handlers.List({ Path: '.' }), [])
})

test('WriteBytes rejects a non-string and malformed base64', async () =>
{
    const handlers = StorageFx.Handlers()
    await StorageFx.Rejects(() => handlers.WriteBytes({ Path: 'a.bin', BytesBase64: 42 as unknown as string }))
    await StorageFx.Rejects(() => handlers.WriteBytes({ Path: 'a.bin', BytesBase64: 'not base64!' }))
    await StorageFx.Rejects(() => handlers.WriteBytes({ Path: 'a.bin', BytesBase64: 'abc' }))
    await handlers.WriteBytes({ Path: 'a.bin', BytesBase64: 'AAEC' })
})

test('WriteText rejects a non-string Content with InvalidParams', async () =>
{
    const handlers = StorageFx.Handlers()
    await StorageFx.Rejects(() => handlers.WriteText({ Path: 'a.txt', Content: 42 as unknown as string }))
    await StorageFx.Rejects(() => handlers.WriteText({ Path: 'a.txt', Content: undefined as unknown as string }))
})

class RoutingFx
{
    public static Roots(): EnvSolutionRoots
    {
        const stores = new Map<string, FakeStorage>()
        const registry: IStorageProviderRegistry = {
            CreateStorage: (location: string) =>
            {
                const store = stores.get(location) ?? new FakeStorage(location)
                stores.set(location, store)
                return store
            }
        }
        return new EnvSolutionRoots('env/src', registry)
    }

    public static Connection(roots: EnvSolutionRoots, active: FakeStorage | undefined, activeName: string | undefined, select?: string): RemoteStorageHandlers
    {
        const target = new AuthoringTarget(() => activeName)
        if (select !== undefined)
        {
            target.Select(select)
        }
        const resolver = new AuthoringStorageResolver(target, roots, () => activeName, () => active)
        return new RemoteStorageHandlers(() => resolver.Resolve())
    }
}

test('two connections selecting different solutions read and write disjoint roots', async () =>
{
    const roots = RoutingFx.Roots()
    roots.EnsureRoot('A')
    roots.EnsureRoot('B')
    const a = RoutingFx.Connection(roots, undefined, undefined, 'A')
    const b = RoutingFx.Connection(roots, undefined, undefined, 'B')
    await a.WriteText({ Path: 'f.txt', Content: 'from-a' })
    await b.WriteText({ Path: 'f.txt', Content: 'from-b' })
    assert.equal((await a.ReadText({ Path: 'f.txt' })).Content, 'from-a')
    assert.equal((await b.ReadText({ Path: 'f.txt' })).Content, 'from-b')
    assert.equal(await roots.RootFor('A').ReadText('f.txt'), 'from-a')
    assert.equal(await roots.RootFor('B').ReadText('f.txt'), 'from-b')
})

test('confinement still applies relative to the selected solution root', async () =>
{
    const roots = RoutingFx.Roots()
    roots.EnsureRoot('A')
    roots.EnsureRoot('B')
    await roots.RootFor('B').WriteText('secret.txt', 's')
    const a = RoutingFx.Connection(roots, undefined, undefined, 'A')
    await StorageFx.Rejects(() => a.ReadText({ Path: '../B/secret.txt' }))
    await StorageFx.Rejects(() => a.ReadText({ Path: '/B/secret.txt' }))
    await StorageFx.Rejects(() => a.ReadText({ Path: 'C:B/secret.txt' }))
    await StorageFx.Rejects(() => a.ReadText({ Path: 'x/b:stream' }))
    await StorageFx.Rejects(() => a.ReadText({ Path: 'x/b\0c' }))
    await StorageFx.Rejects(() => a.Delete({ Path: '' }))
    await StorageFx.Rejects(() => a.Rename({ From: '.', To: 'z' }))
    await StorageFx.Rejects(() => a.WriteText({ Path: 'a/..', Content: 'x' }))
    assert.equal(await roots.RootFor('B').Exists('secret.txt'), true)
})

test('a Windows trailing-dot/space escape from one solution root cannot reach a sibling solution root', async () =>
{
    const roots = RoutingFx.Roots()
    roots.EnsureRoot('A')
    roots.EnsureRoot('B')
    await roots.RootFor('B').WriteText('secret.txt', 's')
    const a = RoutingFx.Connection(roots, undefined, undefined, 'A')
    for (const path of ['.. /B/secret.txt', '.../B/secret.txt', '.. ', 'a/.. /.. /B/secret.txt'])
    {
        await StorageFx.Rejects(() => a.ReadText({ Path: path }))
        await StorageFx.Rejects(() => a.WriteText({ Path: path, Content: 'poisoned' }))
        await StorageFx.Rejects(() => a.Delete({ Path: path }))
    }
    assert.equal(await roots.RootFor('B').ReadText('secret.txt'), 's')
})

test('with no selection the active solution storage is used (Phase-2 back-compat)', async () =>
{
    const roots = RoutingFx.Roots()
    roots.EnsureRoot('Active')
    const active = new FakeStorage()
    const conn = RoutingFx.Connection(roots, active, 'Active')
    await conn.WriteText({ Path: 'x.txt', Content: 'act' })
    assert.equal(await active.ReadText('x.txt'), 'act')
    assert.equal(await roots.RootFor('Active').Exists('x.txt'), false)
})

test('selecting the active solution explicitly still uses the active storage', async () =>
{
    const roots = RoutingFx.Roots()
    const active = new FakeStorage()
    const conn = RoutingFx.Connection(roots, active, 'Active', 'Active')
    await conn.WriteText({ Path: 'x.txt', Content: 'act' })
    assert.equal(await active.Exists('x.txt'), true)
})

test('an unknown or invalid selection is refused, never routed to another root', async () =>
{
    const roots = RoutingFx.Roots()
    const active = new FakeStorage()
    for (const bad of ['Missing', '../A', 'a/b'])
    {
        const conn = RoutingFx.Connection(roots, active, 'Active', bad)
        await assert.rejects(() => conn.WriteText({ Path: 'x.txt', Content: 'x' }), (e: unknown) => e instanceof ResponseError && e.code === ErrorCodes.InvalidRequest)
    }
    assert.equal(await active.Exists('x.txt'), false)
})

class BridgeFx
{
    public readonly Calls: string[] = []

    public get Bridge(): SourceChangeBridge
    {
        return { TextWritten: (_s: unknown, path: string) => this.Calls.push('text:' + path), Deleted: (path: string) => this.Calls.push('del:' + path) } as unknown as SourceChangeBridge
    }

    public Connection(roots: EnvSolutionRoots, active: FakeStorage, select?: string): RemoteStorageHandlers
    {
        const target = new AuthoringTarget(() => 'Active')
        if (select !== undefined)
        {
            target.Select(select)
        }
        const resolver = new AuthoringStorageResolver(target, roots, () => 'Active', () => active, this.Bridge)
        return new RemoteStorageHandlers(() => resolver.Resolve(), () => resolver.Bridge())
    }
}

test('a write to the active root notifies the active bridge; a write to a non-active root does not', async () =>
{
    const roots = RoutingFx.Roots()
    roots.EnsureRoot('Other')
    const fx = new BridgeFx()
    const active = new FakeStorage()
    const unselected = fx.Connection(roots, active)
    await unselected.WriteText({ Path: 'a.todl', Content: 'x' })
    assert.deepEqual(fx.Calls, ['text:a.todl'])
    const explicitActive = fx.Connection(roots, active, 'Active')
    await explicitActive.WriteText({ Path: 'b.todl', Content: 'x' })
    assert.deepEqual(fx.Calls, ['text:a.todl', 'text:b.todl'])
    const other = fx.Connection(roots, active, 'Other')
    await other.WriteText({ Path: 'c.todl', Content: 'x' })
    await other.Delete({ Path: 'c.todl' })
    assert.deepEqual(fx.Calls, ['text:a.todl', 'text:b.todl'])
    assert.equal(await roots.RootFor('Other').Exists('c.todl'), false)
})

class ManifestFx
{
    public static readonly Name = 'Other'
    public static readonly Manifest = 'Other.pksln'
    public static readonly Renamed = 'Renamed.pksln'
    public static readonly MemberDir = 'm1'
    public static readonly Selected = 'Other'

    public static Text(paths: string[]): string
    {
        return JSON.stringify({ kind: 'todl-solution', version: 1, name: ManifestFx.Name, members: paths.map(path => ({ path, type: 'meta-model' })), settings: {} })
    }

    public static Make(): { roots: EnvSolutionRoots, handlers: RemoteStorageHandlers, store: FakeStorage }
    {
        const roots = RoutingFx.Roots()
        const store = roots.EnsureRoot(ManifestFx.Name) as FakeStorage
        const refresher = new SolutionManifestRefresher(roots, { ActiveSolution: undefined } as unknown as SolutionManagerService)
        const target = new AuthoringTarget(() => 'Active')
        target.Select(ManifestFx.Selected)
        const resolver = new AuthoringStorageResolver(target, roots, () => 'Active', () => new FakeStorage(), undefined, refresher)
        return { roots, handlers: new RemoteStorageHandlers(() => resolver.Resolve(), () => resolver.Bridge(), () => resolver.ManifestReaction()), store }
    }

    public static Members(roots: EnvSolutionRoots): string[]
    {
        return roots.MembersOf(ManifestFx.Name).map(m => m.Ref.path)
    }
}

test('a manifest WriteBytes refreshes the solution members live', async () =>
{
    const { roots, handlers } = ManifestFx.Make()
    await handlers.WriteBytes({ Path: ManifestFx.Manifest, BytesBase64: Buffer.from(ManifestFx.Text([ManifestFx.MemberDir])).toString('base64') })
    assert.deepEqual(ManifestFx.Members(roots), [ManifestFx.MemberDir])
})

test('a manifest Delete clears the solution members', async () =>
{
    const { roots, handlers } = ManifestFx.Make()
    await handlers.WriteText({ Path: ManifestFx.Manifest, Content: ManifestFx.Text([ManifestFx.MemberDir]) })
    assert.deepEqual(ManifestFx.Members(roots), [ManifestFx.MemberDir])
    await handlers.Delete({ Path: ManifestFx.Manifest })
    assert.deepEqual(ManifestFx.Members(roots), [])
})

test('a manifest Rename refreshes for both the from and the to path', async () =>
{
    const { roots, handlers } = ManifestFx.Make()
    await handlers.WriteText({ Path: ManifestFx.Manifest, Content: ManifestFx.Text([ManifestFx.MemberDir]) })
    // Renaming the manifest away (from = manifest): the old manifest no longer exists, the renamed file is still a manifest, so its members remain visible.
    await handlers.Rename({ From: ManifestFx.Manifest, To: ManifestFx.Renamed })
    assert.deepEqual(ManifestFx.Members(roots), [ManifestFx.MemberDir])
    // Renaming a non-manifest onto a manifest path (to = manifest) is picked up through the `to` side.
    await handlers.WriteText({ Path: 'draft.txt', Content: ManifestFx.Text([]) })
    await handlers.Delete({ Path: ManifestFx.Renamed })
    assert.deepEqual(ManifestFx.Members(roots), [])
    await handlers.Rename({ From: 'draft.txt', To: ManifestFx.Manifest })
    assert.deepEqual(ManifestFx.Members(roots), [])
    await handlers.WriteText({ Path: 'draft2.txt', Content: ManifestFx.Text([ManifestFx.MemberDir]) })
    await handlers.Rename({ From: 'draft2.txt', To: ManifestFx.Manifest })
    assert.deepEqual(ManifestFx.Members(roots), [ManifestFx.MemberDir])
})
