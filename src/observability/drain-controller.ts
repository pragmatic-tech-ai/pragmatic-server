/** The current count of outstanding units of work (requests in flight, or live connections). */
export interface IInFlightSource
{
    InFlight(): number
}

/** The result of a bounded drain wait. Counts only — never identifiers. */
export interface IDrainOutcome
{
    Drained: boolean
    Remaining: number
    ElapsedMs: number
}

/** Bounded wait for an in-flight count to reach zero. Polls the source until it is zero or the window elapses,
 *  then reports the outcome. A throwing source is treated as zero so the drain never hangs on telemetry. */
export class DrainController
{
    private static readonly DefaultPollMs = 25

    private readonly timeoutMs: number
    private readonly pollMs: number
    private readonly now: () => number
    private readonly sleep: (ms: number) => Promise<void>

    public constructor(
        timeoutMs: number,
        now: () => number = () => Date.now(),
        sleep: (ms: number) => Promise<void> = DrainController.RealSleep,
        pollMs: number = DrainController.DefaultPollMs)
    {
        this.timeoutMs = timeoutMs
        this.now = now
        this.sleep = sleep
        this.pollMs = Math.max(1, pollMs)
    }

    public async WaitForDrain(source: IInFlightSource): Promise<IDrainOutcome>
    {
        const start = this.now()
        for (;;)
        {
            const remaining = this.Count(source)
            if (remaining <= 0)
            {
                return { Drained: true, Remaining: 0, ElapsedMs: this.now() - start }
            }
            const elapsed = this.now() - start
            if (elapsed >= this.timeoutMs)
            {
                return { Drained: false, Remaining: remaining, ElapsedMs: elapsed }
            }
            await this.sleep(this.pollMs)
        }
    }

    private Count(source: IInFlightSource): number
    {
        try
        {
            return source.InFlight()
        }
        catch
        {
            return 0
        }
    }

    private static RealSleep(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => setTimeout(resolve, ms))
    }
}
