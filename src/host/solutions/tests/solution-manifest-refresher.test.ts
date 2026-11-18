import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { Solution } from '@pragmatic-tech-ai/todl'
import type { IStorageProviderRegistry, SolutionManagerService } from '@pragmatic-tech-ai/todl'
import { EnvSolutionRoots } from '../env-solution-roots.js'
import { SolutionManifestRefresher } from '../solution-manifest-refresher.js'

class FakeRegistry implements IStorageProviderRegistry
{
    private readonly stores = new Map<string, FakeStorage>()

    public CreateStorage(location: string): IStorage
    {
        let store = this.stores.get(location)
        if (store === undefined)
        {
            store = new FakeStorage(location)
            this.stores.set(location, store)
        }
        return store
    }
}

class CountingRoots extends EnvSolutionRoots
{
    public FullRefreshes = 0

    public override async Refresh(): Promise<void>
    {
        this.FullRefreshes++
        await super.Refresh()
    }
}

class RefresherFx
{
    public static readonly Area = 'env/src'
    public static readonly Name = 'Alpha'
    public static readonly Manifest = 'Alpha.pksln'
    public static readonly MemberType = 'meta-model'
    public static readonly MemberPath = 'alpha-models'
    public static readonly OtherDir = 'not-a-member'
    public static readonly Nested = 'nested/'
    public static readonly ProjectFile = '/project.plexus'
    public static readonly ModelFile = '/model.todl'
    public static readonly Ghost = 'Ghost'
    public static readonly InMemoryPath = 'in-memory'

    public static ManifestText(paths: string[]): string
    {
        return JSON.stringify({ kind: 'todl-solution', version: 1, name: RefresherFx.Name, members: paths.map(path => ({ path, type: RefresherFx.MemberType })), settings: {} })
    }

    public static async Make(): Promise<{ roots: CountingRoots, store: IStorage, solution: Solution, refresher: SolutionManifestRefresher }>
    {
        const roots = new CountingRoots(RefresherFx.Area, new FakeRegistry())
        const store = roots.EnsureRoot(RefresherFx.Name)
        await store.WriteText(RefresherFx.Manifest, RefresherFx.ManifestText([]))
        await roots.RefreshSolution(RefresherFx.Name)
        const solution = new Solution(RefresherFx.Name)
        const manager = { ActiveSolution: solution } as unknown as SolutionManagerService
        return { roots, store, solution, refresher: new SolutionManifestRefresher(roots, manager) }
    }
}

test('a manifest write refreshes only that solution, with no manual Refresh and no full rescan, and syncs the active members', async () =>
{
    const { roots, store, solution, refresher } = await RefresherFx.Make()
    await store.WriteText(RefresherFx.Manifest, RefresherFx.ManifestText([RefresherFx.MemberPath]))
    await refresher.PathsChanged(RefresherFx.Name, [RefresherFx.Manifest])
    assert.deepEqual(roots.MembersOf(RefresherFx.Name).map(m => m.Ref.path), [RefresherFx.MemberPath])
    assert.deepEqual(solution.Members.ToArray().map(m => m.Ref.path), [RefresherFx.MemberPath])
    assert.equal(solution.IsDirty, false)
    assert.equal(roots.FullRefreshes, 0)
    await store.WriteText(RefresherFx.Manifest, RefresherFx.ManifestText([]))
    await refresher.PathsChanged(RefresherFx.Name, [RefresherFx.Manifest])
    assert.deepEqual(roots.MembersOf(RefresherFx.Name), [])
    assert.deepEqual(solution.Members.ToArray(), [])
})

test('a plain content edit does not re-read the manifest', async () =>
{
    const { roots, store, refresher } = await RefresherFx.Make()
    await store.WriteText(RefresherFx.Manifest, RefresherFx.ManifestText([RefresherFx.MemberPath]))
    await refresher.PathsChanged(RefresherFx.Name, [RefresherFx.MemberPath + RefresherFx.ModelFile, RefresherFx.Nested + RefresherFx.Manifest])
    assert.deepEqual(roots.MembersOf(RefresherFx.Name), [])
})

test('an unknown solution name is a no-op', async () =>
{
    const { refresher } = await RefresherFx.Make()
    await refresher.PathsChanged(RefresherFx.Ghost, [RefresherFx.Manifest])
})

test('a member project manifest write forces one recompose without re-reading the solution manifest', async () =>
{
    const { roots, store, refresher } = await RefresherFx.Make()
    await store.WriteText(RefresherFx.Manifest, RefresherFx.ManifestText([RefresherFx.MemberPath]))
    await refresher.PathsChanged(RefresherFx.Name, [RefresherFx.Manifest])
    let changes = 0
    roots.Changed.subscribe(() => changes++)
    await refresher.PathsChanged(RefresherFx.Name, [RefresherFx.MemberPath + RefresherFx.ProjectFile])
    assert.equal(changes, 1)
    await refresher.PathsChanged(RefresherFx.Name, [RefresherFx.MemberPath + RefresherFx.ModelFile])
    assert.equal(changes, 1)
})

test('a deeply nested project.plexus, or one for a non-member directory, does not recompose', async () =>
{
    const { roots, store, refresher } = await RefresherFx.Make()
    await store.WriteText(RefresherFx.Manifest, RefresherFx.ManifestText([RefresherFx.MemberPath]))
    await refresher.PathsChanged(RefresherFx.Name, [RefresherFx.Manifest])
    let changes = 0
    roots.Changed.subscribe(() => changes++)
    await refresher.PathsChanged(RefresherFx.Name, [RefresherFx.MemberPath + RefresherFx.Nested + RefresherFx.MemberPath + RefresherFx.ProjectFile])
    await refresher.PathsChanged(RefresherFx.Name, [RefresherFx.OtherDir + RefresherFx.ProjectFile])
    assert.equal(changes, 0)
})

test('a dirty active solution keeps its unsaved in-memory member: the reconcile is skipped while the roots cache still refreshes', async () =>
{
    const { roots, store, solution, refresher } = await RefresherFx.Make()
    solution.AddMember(RefresherFx.InMemoryPath, RefresherFx.MemberType)
    solution.IsDirty = true
    await store.WriteText(RefresherFx.Manifest, RefresherFx.ManifestText([RefresherFx.MemberPath]))
    await refresher.PathsChanged(RefresherFx.Name, [RefresherFx.Manifest])
    assert.deepEqual(roots.MembersOf(RefresherFx.Name).map(m => m.Ref.path), [RefresherFx.MemberPath])
    assert.deepEqual(solution.Members.ToArray().map(m => m.Ref.path), [RefresherFx.InMemoryPath])
    assert.equal(solution.IsDirty, true)
})

test('RefreshSolution reports a change only when the member set differs', async () =>
{
    const { roots, store } = await RefresherFx.Make()
    assert.equal(await roots.RefreshSolution(RefresherFx.Name), false)
    await store.WriteText(RefresherFx.Manifest, RefresherFx.ManifestText([RefresherFx.MemberPath]))
    assert.equal(await roots.RefreshSolution(RefresherFx.Name), true)
    await store.WriteText(RefresherFx.Manifest, RefresherFx.ManifestText([RefresherFx.MemberPath]))
    assert.equal(await roots.RefreshSolution(RefresherFx.Name), false)
})
