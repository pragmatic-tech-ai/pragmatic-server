import { type SolutionManagerService, PROJECT_MANIFEST_FILENAME } from '@pragmatic-tech-ai/todl'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { EnvSolutionRoots } from './env-solution-roots.js'
import { StructuredLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'

/**
 * Closes the live-refresh gap after `storage/*` writes: when a write touches a solution's manifest (`<name>.pksln`), the
 * env roots cache re-reads just that solution (so ListSolutions / AuthoringSummary / the composed member set follow), and
 * when it is the manager's ACTIVE solution its in-memory member list is reconciled to the new manifest. Plain content
 * edits never reach here (they flow through the SourceChangeBridge), so no per-keystroke rescan happens.
 */
export class SolutionManifestRefresher
{
    private static readonly Separator = '/'
    private static readonly FunctionType = 'function'
    private static readonly FailureLine = 'solution manifest live-refresh failed; the roots cache may be stale until the next Refresh: '
    private static readonly UnknownName = 'UnknownError'

    public constructor(private readonly roots: EnvSolutionRoots, private readonly manager: SolutionManagerService, private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    /** A reaction bound to one solution name, run after a write/delete/rename with the root-relative paths it touched. */
    public For(solutionName: string): (paths: readonly string[]) => Promise<void>
    {
        return paths => this.PathsChanged(solutionName, paths)
    }

    /** Refreshes when any path is a root-level manifest. Best effort: the write is already committed, so a failure never surfaces. */
    public async PathsChanged(solutionName: string, paths: readonly string[]): Promise<void>
    {
        const solutionManifest = paths.some(path => EnvSolutionRoots.IsManifestPath(path))
        const memberDirs = paths.filter(path => SolutionManifestRefresher.IsMemberManifest(path)).map(path => path.slice(0, path.indexOf(SolutionManifestRefresher.Separator)))
        if (!solutionManifest && memberDirs.length === 0)
        {
            return
        }
        try
        {
            if (solutionManifest && await this.roots.RefreshSolution(solutionName))
            {
                this.SyncActive(solutionName)
            }
            if (memberDirs.length > 0)
            {
                // A member's project manifest landing after the solution manifest already listed it: the member set is unchanged but the
                // language service only builds a member whose manifest exists, so force one recompose (content edits stay on the bridge).
                for (const dir of memberDirs)
                {
                    this.roots.Invalidate(solutionName, dir)
                }
            }
        }
        catch (error)
        {
            // best effort (the write is committed): record it so a stale view is diagnosable; the next explicit Refresh resynchronizes
            this.logger.Warn(SolutionManifestRefresher.FailureLine + (error instanceof Error ? error.name : SolutionManifestRefresher.UnknownName))
        }
    }

    /**
     * Reconciles the active solution's members to the roots cache (add new, drop gone); membership edits made here do not dirty it.
     * A solution that is ALREADY dirty holds an unsaved in-memory membership edit that the manifest does not yet contain, so the
     * reconcile is skipped (the roots cache is already refreshed) rather than clobber it.
     */
    private SyncActive(solutionName: string): void
    {
        const solution = this.manager.ActiveSolution
        if (solution === undefined || solution.Name !== solutionName)
        {
            return
        }
        if (solution.IsDirty)
        {
            return
        }
        const wanted = this.roots.MembersOf(solutionName)
        for (const member of solution.Members.ToArray())
        {
            if (!wanted.some(w => SolutionManifestRefresher.Same(w, member)))
            {
                SolutionManifestRefresher.DisposeProject(member.Project)
                solution.RemoveMember(member)
            }
        }
        for (const want of wanted)
        {
            if (!solution.Members.ToArray().some(m => SolutionManifestRefresher.Same(m, want)))
            {
                solution.AddMember(want.Ref.path, want.Ref.type).Storage = want.Storage
            }
        }
        solution.IsDirty = false
    }

    /** SolutionMember.Project is typed `unknown` by the engine, so the IDisposable contract is probed, not assumed. Best effort. */
    private static DisposeProject(project: unknown): void
    {
        const disposable = project as Partial<IDisposable> | undefined
        if (typeof disposable?.dispose === SolutionManifestRefresher.FunctionType)
        {
            disposable?.dispose?.()
        }
    }

    /** A member's own project manifest: `<member>/project.plexus`, exactly one directory below the solution root. */
    private static IsMemberManifest(path: string): boolean
    {
        const parts = path.split(SolutionManifestRefresher.Separator)
        return parts.length === 2 && parts[0].length > 0 && parts[1] === PROJECT_MANIFEST_FILENAME
    }

    private static Same(a: { Ref: { path: string, type: string } }, b: { Ref: { path: string, type: string } }): boolean
    {
        return a.Ref.path === b.Ref.path && a.Ref.type === b.Ref.type
    }
}
