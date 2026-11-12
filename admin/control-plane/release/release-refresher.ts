import { ReleaseRegistryUnavailableError } from '../rollout-errors.js'
import type { ReleaseRefreshResult } from './release-catalog.js'

/** What the refresher serializes: the release catalogue (or a test stand-in). */
export interface IReleaseRefreshSource
{
    Refresh(): Promise<ReleaseRefreshResult>
}

/**
 * Single flight in front of the release catalogue: the operator refresh route and the periodic poll never run two
 * refreshes at once. A call that arrives while one is in flight awaits that refresh and gets its result (or its error).
 */
export class ReleaseRefresher
{
    private inFlight: Promise<ReleaseRefreshResult> | undefined

    public constructor(private readonly source: IReleaseRefreshSource)
    {
    }

    public Refresh(): Promise<ReleaseRefreshResult>
    {
        if (this.inFlight !== undefined)
        {
            return this.inFlight
        }
        // Started on a later tick, so the slot is always taken before the refresh can settle and free it.
        const run: Promise<ReleaseRefreshResult> = Promise.resolve()
            .then(() => this.source.Refresh())
            .finally(() => this.Release(run))
        this.inFlight = run
        return run
    }

    /**
     * The loggable text of a refresh failure: the fixed, token-free sentence of a registry failure, else the error's name
     * only (inner text could carry a credential or a path).
     */
    public static FailureText(err: unknown): string
    {
        if (err instanceof ReleaseRegistryUnavailableError)
        {
            return err.message
        }
        return err instanceof Error ? err.name : typeof err
    }

    private Release(run: Promise<ReleaseRefreshResult>): void
    {
        if (this.inFlight === run)
        {
            this.inFlight = undefined
        }
    }
}
