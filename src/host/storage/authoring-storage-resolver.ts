import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { AuthoringTarget } from '../solutions/authoring-target.js'
import { InvalidSolutionNameError, UnknownSolutionRootError } from '../solutions/env-solution-roots.js'
import type { EnvSolutionRoots } from '../solutions/env-solution-roots.js'
import type { SourceChangeBridge } from '../solutions/source-change-bridge.js'
import type { SolutionManifestRefresher } from '../solutions/solution-manifest-refresher.js'

/**
 * Resolves the storage root a connection's `storage/*` requests act on. A solution the connection selected explicitly
 * routes to that solution's own root; with no selection (Phase-2 behaviour) or when the selection is the active solution,
 * the active solution's storage is used. An invalid or unknown selection resolves to nothing (the handlers then refuse),
 * never to a different solution's root.
 */
export class AuthoringStorageResolver
{
    private resolvedActive = false
    private resolvedName: string | undefined

    public constructor(
        private readonly target: AuthoringTarget,
        private readonly roots: EnvSolutionRoots | undefined,
        private readonly activeName: () => string | undefined,
        private readonly activeStorage: () => IStorage | undefined,
        private readonly bridge?: SourceChangeBridge,
        private readonly refresher?: SolutionManifestRefresher)
    {
    }

    /** Whether the most recent {@link Resolve} returned the active solution's own storage. */
    public ResolvedActive(): boolean
    {
        return this.resolvedActive
    }

    /**
     * The source-change bridge for the most recent {@link Resolve}: the active solution's bridge only when that resolution was the
     * active root, otherwise none (the bridge feeds the ACTIVE language service, so a write to another root must not signal it).
     */
    public Bridge(): SourceChangeBridge | undefined
    {
        return this.resolvedActive ? this.bridge : undefined
    }

    /** The manifest-refresh reaction for the most recent {@link Resolve}'s solution, bound at call time; none when no refresher or no resolved solution. */
    public ManifestReaction(): ((paths: readonly string[]) => Promise<void>) | undefined
    {
        return this.refresher !== undefined && this.resolvedName !== undefined ? this.refresher.For(this.resolvedName) : undefined
    }

    public Resolve(): IStorage | undefined
    {
        this.resolvedActive = false
        this.resolvedName = undefined
        const selected = this.target.Selected
        if (selected === undefined || this.roots === undefined || selected === this.activeName())
        {
            this.resolvedActive = true
            this.resolvedName = this.activeName()
            return this.activeStorage()
        }
        try
        {
            const root = this.roots.RootFor(selected)
            this.resolvedName = selected
            return root
        }
        catch (error)
        {
            if (error instanceof InvalidSolutionNameError || error instanceof UnknownSolutionRootError)
            {
                return undefined
            }
            throw error
        }
    }
}
