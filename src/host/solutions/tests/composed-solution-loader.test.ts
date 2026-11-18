import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Signal, Observable, FakeStorage } from '@pragmatic-tech-ai/todl-runtime'
import { SolutionMember } from '@pragmatic-tech-ai/todl'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import { ComposedSolutionLoader } from '../composed-solution-loader.js'
import type { IEnvSolutionSource } from '../composed-solution-loader.js'

class FakeActive
{
    public constructor(public readonly Members: { ToArray(): SolutionMember[] })
    {
    }
}

class FakeManager extends Observable
{
    private static readonly ActiveName = 'ActiveSolution'
    private active: FakeActive | undefined

    public get ActiveSolution(): FakeActive | undefined
    {
        return this.active
    }

    public SetActive(members: SolutionMember[]): void
    {
        const old = this.active
        this.active = new FakeActive({ ToArray: () => members })
        this.RaisePropertyChanged(FakeManager.ActiveName, old, this.active)
    }
}

class FakeSource implements IEnvSolutionSource
{
    public readonly Changed = new Signal<void>()
    public readonly Solutions = new Map<string, SolutionMember[]>()

    public Names(): readonly string[]
    {
        return [...this.Solutions.keys()]
    }

    public MembersOf(name: string): readonly SolutionMember[]
    {
        return this.Solutions.get(name) ?? []
    }

    public Put(name: string, members: SolutionMember[]): void
    {
        this.Solutions.set(name, members)
        this.Changed.emit()
    }

    public Drop(name: string): void
    {
        this.Solutions.delete(name)
        this.Changed.emit()
    }
}

class Fx
{
    private static readonly MemberType = 'todl'

    public readonly Manager = new FakeManager()
    public readonly Source = new FakeSource()
    public readonly Loader = new ComposedSolutionLoader(this.Manager as unknown as SolutionManagerService, this.Source)
    public readonly Quarantined: string[] = []

    public constructor()
    {
        this.Loader.OverlapQuarantined.subscribe(message => this.Quarantined.push(message))
    }

    /** A member keyed, in production, on its ABSOLUTE storage root; `root` sets that root, otherwise identity falls back to `path`. */
    public static Member(path: string, root?: string): SolutionMember
    {
        const member = new SolutionMember({ path, type: Fx.MemberType })
        if (root !== undefined)
        {
            member.Storage = new FakeStorage(root)
        }
        return member
    }
}

test('Members unions the active solution with other named solutions', () =>
{
    const fx = new Fx()
    const a = Fx.Member('a')
    const b = Fx.Member('b')
    const c = Fx.Member('c')
    fx.Manager.SetActive([a])
    fx.Source.Solutions.set('one', [b])
    fx.Source.Solutions.set('two', [c])
    assert.deepEqual(fx.Loader.Members(), [a, b, c])
})

test('the active solution is not duplicated when it also appears in the source', () =>
{
    const fx = new Fx()
    const a = Fx.Member('a')
    fx.Manager.SetActive([a])
    fx.Source.Solutions.set('active', [a])
    assert.deepEqual(fx.Loader.Members(), [a])
})

test('ActiveSolution is unchanged after constructing and using the loader', () =>
{
    const fx = new Fx()
    fx.Manager.SetActive([Fx.Member('a')])
    const before = fx.Manager.ActiveSolution
    fx.Source.Solutions.set('one', [Fx.Member('b')])
    fx.Loader.Members()
    assert.equal(fx.Manager.ActiveSolution, before)
})

test('a genuinely nested member is quarantined (non-fatal), the rest keep composing', () =>
{
    const fx = new Fx()
    const outer = Fx.Member('models', '/area/A/models')
    fx.Manager.SetActive([outer])
    fx.Source.Solutions.set('one', [Fx.Member('inner', '/area/A/models/inner')])
    const members = fx.Loader.Members()
    assert.deepEqual(members, [outer])
    assert.equal(fx.Quarantined.length, 1)
})

test('two members on the same root but different types quarantine the second rather than throwing', () =>
{
    const fx = new Fx()
    const first = Fx.Member('x', '/area/A/x')
    fx.Manager.SetActive([first])
    const other = new SolutionMember({ path: 'x', type: 'other' })
    other.Storage = new FakeStorage('/area/A/x')
    fx.Source.Solutions.set('one', [other])
    assert.deepEqual(fx.Loader.Members(), [first])
    assert.equal(fx.Quarantined.length, 1)
})

test('two solutions sharing a member dir name both compose: no collapse, no quarantine', () =>
{
    const fx = new Fx()
    const a = Fx.Member('models', '/area/A/models')
    const b = Fx.Member('models', '/area/B/models')
    fx.Source.Solutions.set('A', [a])
    fx.Source.Solutions.set('B', [b])
    const members = fx.Loader.Members()
    assert.equal(members.length, 2)
    assert.deepEqual([...members].sort((x, y) => (x.Storage!.Root).localeCompare(y.Storage!.Root)), [a, b])
    assert.equal(fx.Quarantined.length, 0)
})

test('an active member with an empty or .. relative path is dropped by confinement, not tripping overlap', () =>
{
    const fx = new Fx()
    const good = Fx.Member('models', '/area/A/models')
    fx.Manager.SetActive([Fx.Member('..'), Fx.Member('')])
    fx.Source.Solutions.set('A', [good])
    assert.deepEqual(fx.Loader.Members(), [good])
    assert.equal(fx.Quarantined.length, 0)
})

test('sibling roots sharing a name prefix do not overlap', () =>
{
    const fx = new Fx()
    fx.Manager.SetActive([Fx.Member('app', '/area/A/app')])
    fx.Source.Solutions.set('one', [Fx.Member('app2', '/area/A/app2')])
    assert.equal(fx.Loader.Members().length, 2)
})

test('Changed fires on source add/remove and active-solution change, and stops after dispose', () =>
{
    const fx = new Fx()
    let count = 0
    fx.Loader.Changed.subscribe(() => { count++ })
    fx.Source.Put('one', [Fx.Member('b')])
    fx.Source.Drop('one')
    fx.Manager.SetActive([Fx.Member('a')])
    assert.equal(count, 3)
    fx.Loader.dispose()
    fx.Source.Put('two', [])
    fx.Manager.SetActive([])
    assert.equal(count, 3)
})

test('distinct instances with the same root dedupe without throwing, then a nested one quarantines', () =>
{
    const fx = new Fx()
    fx.Manager.SetActive([Fx.Member('proj', '/area/A/proj')])
    fx.Source.Solutions.set('active', [Fx.Member('proj', '/area/A/proj')])
    assert.equal(fx.Loader.Members().length, 1)
    assert.equal(fx.Quarantined.length, 0)
    fx.Source.Solutions.set('nested', [Fx.Member('inner', '/area/A/proj/inner')])
    assert.equal(fx.Loader.Members().length, 1)
    assert.equal(fx.Quarantined.length, 1)
})

test('backslash and trailing-slash roots are normalized for overlap', () =>
{
    const back = new Fx()
    back.Manager.SetActive([Fx.Member('inner', '/area/A/proj\\inner')])
    back.Source.Solutions.set('one', [Fx.Member('proj', '/area/A/proj')])
    assert.equal(back.Loader.Members().length, 1)
    assert.equal(back.Quarantined.length, 1)
    const trailing = new Fx()
    trailing.Manager.SetActive([Fx.Member('proj', '/area/A/proj/')])
    trailing.Source.Solutions.set('one', [Fx.Member('inner', '/area/A/proj/inner')])
    assert.equal(trailing.Loader.Members().length, 1)
    assert.equal(trailing.Quarantined.length, 1)
})

test('dispose twice is a no-op', () =>
{
    const fx = new Fx()
    fx.Loader.dispose()
    assert.doesNotThrow(() => fx.Loader.dispose())
})

test('Members with no active solution returns only the source members', () =>
{
    const fx = new Fx()
    const b = Fx.Member('b')
    fx.Source.Solutions.set('one', [b])
    assert.deepEqual(fx.Loader.Members(), [b])
})
