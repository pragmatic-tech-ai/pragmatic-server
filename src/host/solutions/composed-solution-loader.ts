import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IComposedMemberSet, SolutionManagerService, SolutionMember } from '@pragmatic-tech-ai/todl'
import { PathConfinement } from '../path-confinement.js'

/** Supplies the OTHER named solutions' members for an environment; Task 5's EnvSolutionRoots implements it. */
export interface IEnvSolutionSource
{
    Names(): readonly string[]
    MembersOf(name: string): readonly SolutionMember[]
    readonly Changed: Signal<void>
}

/** Describes two composed members whose roots are equal or nested, which would break longest-prefix member lookup. */
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
 * Read-only provider of the composed member set (`IComposedMemberSet`): the active solution's
 * members unioned with every other named solution's members. Only READS the manager; never opens/activates.
 */
export class ComposedSolutionLoader implements IComposedMemberSet, IDisposable
{
    private static readonly ActiveSolutionName = 'ActiveSolution'
    private static readonly EmptyRoot = ''
    private static readonly KeyJoiner = '\u0000'
    private static readonly Separator = '/'
    private static readonly Backslash = /\\/g
    private static readonly TrailingSeparators = /\/+$/

    public readonly Changed = new Signal<void>()
    /**
     * Fires (non-fatal) with an {@link OverlappingMemberRootsError} message each time a member is dropped from the
     * composed set because its absolute root overlaps one already kept. Members() feeds the env-wide shared language
     * service, so a genuine overlap must quarantine the offending slice, never throw and break composition for all.
     */
    public readonly OverlapQuarantined = new Signal<string>()
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
        const byKey = new Map<string, SolutionMember>()
        for (const member of this.Candidates())
        {
            const key = ComposedSolutionLoader.RootOf(member) + ComposedSolutionLoader.KeyJoiner + member.Ref.type
            if (!byKey.has(key))
            {
                byKey.set(key, member)
            }
        }
        return this.Disjoint([...byKey.values()])
    }

    public dispose(): void
    {
        for (const sub of this.subscriptions.splice(0))
        {
            sub.dispose()
        }
    }

    /**
     * The active solution's members unioned with every named solution's, both run through the identical path-confinement
     * filter (the named source already filters at parse time; this also drops an active manifest member with an empty or
     * `..` relative path, so a stray path can't trip the overlap logic for the whole environment).
     */
    private Candidates(): SolutionMember[]
    {
        const candidates = [...(this.manager.ActiveSolution?.Members.ToArray() ?? [])]
        for (const name of this.source.Names())
        {
            candidates.push(...this.source.MembersOf(name))
        }
        return candidates.filter(member => PathConfinement.IsConfinedPath(member.Ref.path))
    }

    /** Keeps the first member of each distinct absolute root and quarantines any later member whose root overlaps a kept one. */
    private Disjoint(members: readonly SolutionMember[]): SolutionMember[]
    {
        const kept: SolutionMember[] = []
        const keptRoots: string[] = []
        for (const member of members)
        {
            const root = ComposedSolutionLoader.RootOf(member)
            const clash = keptRoots.find(existing => ComposedSolutionLoader.Overlaps(root, existing))
            if (clash !== undefined)
            {
                this.OverlapQuarantined.emit(new OverlappingMemberRootsError(root, clash).message)
                continue
            }
            kept.push(member)
            keptRoots.push(root)
        }
        return kept
    }

    /**
     * A member's identity for composition: its resolved storage ROOT, the absolute rooted location the language service
     * keys on (`member.Storage === consumerStorage`). The relative, manifest-local `Ref.path` is non-unique across
     * solutions (two solutions can both own a `models` dir), so it is only a last resort for an as-yet-unresolved member.
     */
    private static RootOf(member: SolutionMember): string
    {
        return ComposedSolutionLoader.Normalize(member.Storage?.Root ?? member.Ref.path)
    }

    private static Normalize(path: string): string
    {
        return path
            .replace(ComposedSolutionLoader.Backslash, ComposedSolutionLoader.Separator)
            .replace(ComposedSolutionLoader.TrailingSeparators, ComposedSolutionLoader.EmptyRoot)
    }

    private static Overlaps(a: string, b: string): boolean
    {
        const sep = ComposedSolutionLoader.Separator
        return a === b || a === ComposedSolutionLoader.EmptyRoot || b === ComposedSolutionLoader.EmptyRoot || a.startsWith(b + sep) || b.startsWith(a + sep)
    }
}
