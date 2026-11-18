import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { AuthoringTarget } from '../solutions/authoring-target.js'
import { InvalidSolutionNameError, UnknownSolutionRootError } from '../solutions/env-solution-roots.js'
import type { EnvSolutionRoots } from '../solutions/env-solution-roots.js'

/**
 * Resolves the storage root a connection's `storage/*` requests act on. A solution the connection selected explicitly
 * routes to that solution's own root; with no selection (Phase-2 behaviour) or when the selection is the active solution,
 * the active solution's storage is used. An invalid or unknown selection resolves to nothing (the handlers then refuse),
 * never to a different solution's root.
 */
export class AuthoringStorageResolver
{
    public constructor(
        private readonly target: AuthoringTarget,
        private readonly roots: EnvSolutionRoots | undefined,
        private readonly activeName: () => string | undefined,
        private readonly activeStorage: () => IStorage | undefined)
    {
    }

    public Resolve(): IStorage | undefined
    {
        const selected = this.target.Selected
        if (selected === undefined || this.roots === undefined || selected === this.activeName())
        {
            return this.activeStorage()
        }
        try
        {
            return this.roots.RootFor(selected)
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
