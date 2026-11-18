import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import { PROJECT_MANIFEST_FILENAME } from '@pragmatic-tech-ai/todl'
import { EnvSolutionRoots } from './env-solution-roots.js'

/**
 * Closes the live-refresh gap after `storage/*` writes: when a write touches a solution's manifest (`<name>.pksln`), the
 * env roots cache re-reads just that solution (so ListSolutions / AuthoringSummary / the composed member set follow), and
 * when it is the manager's ACTIVE solution its in-memory member list is reconciled to the new manifest. Plain content
 * edits never reach here (they flow through the SourceChangeBridge), so no per-keystroke rescan happens.
 */
export class SolutionManifestRefresher
{
    private static readonly Separator = '/'

    public constructor(private readonly roots: EnvSolutionRoots, private readonly manager: SolutionManagerService)
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
        const memberManifest = paths.some(path => SolutionManifestRefresher.IsMemberManifest(path))
        if (!solutionManifest && !memberManifest)
        {
            return
        }
        try
        {
            if (solutionManifest && await this.roots.RefreshSolution(solutionName))
            {
                this.SyncActive(solutionName)
            }
            if (memberManifest)
            {
                // A member's project manifest landing after the solution manifest already listed it: the member set is unchanged but the
                // language service only builds a member whose manifest exists, so force one recompose (content edits stay on the bridge).
                this.roots.Invalidate(solutionName)
            }
        }
        catch
        {
            // best effort: the next explicit Refresh resynchronizes
        }
    }

    /** Reconciles the active solution's members to the roots cache (add new, drop gone); membership edits made here do not dirty it. */
    private SyncActive(solutionName: string): void
    {
        const solution = this.manager.ActiveSolution
        if (solution === undefined || solution.Name !== solutionName)
        {
            return
        }
        const wasDirty = solution.IsDirty
        const wanted = this.roots.MembersOf(solutionName)
        for (const member of solution.Members.ToArray())
        {
            if (!wanted.some(w => SolutionManifestRefresher.Same(w, member)))
            {
                (member.Project as { dispose?: () => void } | undefined)?.dispose?.()
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
        solution.IsDirty = wasDirty
    }

    /** A member's own project manifest: `project.plexus` in a subdirectory of the solution root. */
    private static IsMemberManifest(path: string): boolean
    {
        return path.endsWith(SolutionManifestRefresher.Separator + PROJECT_MANIFEST_FILENAME)
    }

    private static Same(a: { Ref: { path: string, type: string } }, b: { Ref: { path: string, type: string } }): boolean
    {
        return a.Ref.path === b.Ref.path && a.Ref.type === b.Ref.type
    }
}
