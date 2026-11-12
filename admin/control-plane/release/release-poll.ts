import { ReleaseRegistryUnavailableError } from '../rollout-errors.js'
import type { ReleaseRefreshResult } from './release-catalog.js'
import type { ReleaseRefresher } from './release-refresher.js'

/** Where the poll reports: counts on success, a fixed sentence on failure. */
export interface IReleasePollLog
{
    Info(line: string): void
    Warn(line: string): void
}

/** The process console. */
export class ConsoleReleasePollLog implements IReleasePollLog
{
    public Info(line: string): void
    {
        console.log(line)
    }

    public Warn(line: string): void
    {
        console.warn(line)
    }
}

/**
 * Refreshes the release catalogue on an interval through the shared single-flight refresher. The timer never keeps the
 * process alive. Each tick logs only counts, or on failure the registry error's fixed sentence (any other error by name
 * only, so no inner text, which could carry a credential, reaches the log); a failed tick never stops the poll.
 */
export class ReleasePoll
{
    private static readonly CountsPrefix = 'Release poll: imported '
    private static readonly RejectedLabel = ', rejected '
    private static readonly UnchangedLabel = ', unchanged '
    private static readonly ShadowedLabel = ', shadowed '
    private static readonly FailedPrefix = 'Release poll failed: '

    private timer: ReturnType<typeof setInterval> | undefined

    public constructor(
        private readonly refresher: ReleaseRefresher,
        private readonly intervalMs: number,
        private readonly log: IReleasePollLog = new ConsoleReleasePollLog())
    {
    }

    public Start(): void
    {
        if (this.timer !== undefined)
        {
            return
        }
        this.timer = setInterval(() => void this.Tick(), this.intervalMs)
        this.timer.unref()
    }

    public Stop(): void
    {
        if (this.timer !== undefined)
        {
            clearInterval(this.timer)
            this.timer = undefined
        }
    }

    /** One refresh and its log line; never throws. */
    public async Tick(): Promise<void>
    {
        try
        {
            this.log.Info(ReleasePoll.CountsLine(await this.refresher.Refresh()))
        }
        catch (err)
        {
            this.log.Warn(ReleasePoll.FailedPrefix + ReleasePoll.FailureText(err))
        }
    }

    private static CountsLine(result: ReleaseRefreshResult): string
    {
        const P = ReleasePoll
        return P.CountsPrefix + String(result.imported.length) + P.RejectedLabel + String(result.rejected.length)
            + P.UnchangedLabel + String(result.unchanged) + P.ShadowedLabel + String(result.shadowed.length)
    }

    private static FailureText(err: unknown): string
    {
        if (err instanceof ReleaseRegistryUnavailableError)
        {
            return err.message
        }
        return err instanceof Error ? err.name : typeof err
    }
}
