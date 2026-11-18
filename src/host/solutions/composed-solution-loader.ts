import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { SolutionManagerService, SolutionMember } from '@pragmatic-tech-ai/todl'

/** Supplies the OTHER named solutions' members for an environment; Task 5's EnvSolutionRoots implements it. */
export interface IEnvSolutionSource
{
    Names(): readonly string[]
    MembersOf(name: string): readonly SolutionMember[]
    readonly Changed: Signal<void>
}

/** Raised when two composed members' roots are equal or nested, which would break longest-prefix member lookup. */
export class OverlappingMemberRootsError extends Error
{
    private static readonly Prefix = 'Composed solution members have overlapping roots: '
    private static readonly ErrorName = 'OverlappingMemberRootsError'
    private static readonly Joiner = ' and '

    public constructor(first: string, second: string)
    {
        super(OverlappingMemberRootsError.Prefix + first + OverlappingMemberRootsError.Joiner + second)
        this.name = OverlappingMemberRootsError.ErrorName
    }
}

/**
 * Read-only provider of the composed member set (structurally an `IComposedMemberSet`): the active solution's
 * members unioned with every other named solution's members. Only READS the manager; never opens/activates.
 */
export class ComposedSolutionLoader implements IDisposable
{
    private static readonly ActiveSolutionName = 'ActiveSolution'
    private static readonly Separator = '/'
    private static readonly Backslash = /\\/g
    private static readonly TrailingSeparators = /\/+$/

    public readonly Changed = new Signal<void>()
    private readonly subscriptions: IDisposable[] = []

    public constructor(
        private readonly manager: SolutionManagerService,
        private readonly source: IEnvSolutionSource)
    {
        this.subscriptions.push(
            manager.PropertyChanged(ComposedSolutionLoader.ActiveSolutionName).subscribe(() => this.Changed.emit()),
            source.Changed.subscribe(() => this.Changed.emit()))
    }

    public Members(): readonly SolutionMember[]
    {
        const union = new Set<SolutionMember>(this.manager.ActiveSolution?.Members.ToArray() ?? [])
        for (const name of this.source.Names())
        {
            for (const member of this.source.MembersOf(name))
            {
                union.add(member)
            }
        }
        const members = [...union]
        ComposedSolutionLoader.AssertDisjoint(members)
        return members
    }

    public dispose(): void
    {
        for (const sub of this.subscriptions.splice(0))
        {
            sub.dispose()
        }
    }

    private static AssertDisjoint(members: readonly SolutionMember[]): void
    {
        const roots = members.map(m => ComposedSolutionLoader.Normalize(m.Ref.path))
        for (let i = 0; i < roots.length; i++)
        {
            for (let j = i + 1; j < roots.length; j++)
            {
                if (ComposedSolutionLoader.Overlaps(roots[i], roots[j]))
                {
                    throw new OverlappingMemberRootsError(members[i].Ref.path, members[j].Ref.path)
                }
            }
        }
    }

    private static Normalize(path: string): string
    {
        return path
            .replace(ComposedSolutionLoader.Backslash, ComposedSolutionLoader.Separator)
            .replace(ComposedSolutionLoader.TrailingSeparators, '')
    }

    private static Overlaps(a: string, b: string): boolean
    {
        const sep = ComposedSolutionLoader.Separator
        return a === b || a === '' || b === '' || a.startsWith(b + sep) || b.startsWith(a + sep)
    }
}
