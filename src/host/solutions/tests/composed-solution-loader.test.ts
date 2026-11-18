import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Signal, Observable } from '@pragmatic-tech-ai/todl-runtime'
import { SolutionMember } from '@pragmatic-tech-ai/todl'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import { ComposedSolutionLoader, OverlappingMemberRootsError } from '../composed-solution-loader.js'
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
    private static readonly OverlapPattern = /overlapping roots/

    public readonly Manager = new FakeManager()
    public readonly Source = new FakeSource()
    public readonly Loader = new ComposedSolutionLoader(this.Manager as unknown as SolutionManagerService, this.Source)

    public static Member(path: string): SolutionMember
    {
        return new SolutionMember({ path, type: Fx.MemberType })
    }

    public static IsOverlapError(e: unknown): boolean
    {
        return e instanceof OverlappingMemberRootsError && Fx.OverlapPattern.test(e.message)
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

test('overlapping roots are rejected with a named error', () =>
{
    const fx = new Fx()
    fx.Manager.SetActive([Fx.Member('proj')])
    fx.Source.Solutions.set('one', [Fx.Member('proj/inner')])
    assert.throws(() => fx.Loader.Members(), (e: unknown) => Fx.IsOverlapError(e))
    const same = new Fx()
    same.Manager.SetActive([Fx.Member('x')])
    same.Source.Solutions.set('one', [Fx.Member('x')])
    assert.throws(() => same.Loader.Members(), OverlappingMemberRootsError)
})

test('sibling roots sharing a name prefix do not overlap', () =>
{
    const fx = new Fx()
    fx.Manager.SetActive([Fx.Member('app')])
    fx.Source.Solutions.set('one', [Fx.Member('app2')])
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
