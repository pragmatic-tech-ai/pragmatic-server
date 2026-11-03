import { ServiceKey } from '@pragmatic-tech-ai/mural/runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'

// Runs a poll once after a delay; disposing the returned handle cancels it.
// A seam so view-model tests drive polling by hand instead of by the clock.
export interface IPollScheduler
{
    Schedule(delayMs: number, poll: () => void): IDisposable
}

// One pending timer; dispose clears it (a no-op once it ran).
export class ScheduledPoll implements IDisposable
{
    private handle: ReturnType<typeof setTimeout> | undefined

    public constructor(delayMs: number, poll: () => void)
    {
        this.handle = setTimeout(() =>
        {
            this.handle = undefined
            poll()
        }, delayMs)
    }

    public dispose(): void
    {
        if (this.handle !== undefined)
        {
            clearTimeout(this.handle)
            this.handle = undefined
        }
    }
}

// Where a section finds the poll scheduler to hand its pages: registered at
// the app root only to replace the timers (tests); absent means the timers.
export class PollScheduling
{
    public static readonly Key = new ServiceKey<IPollScheduler>('PollScheduler')

    private constructor()
    {
    }
}

// The browser's timers.
export class TimerPollScheduler implements IPollScheduler
{
    public Schedule(delayMs: number, poll: () => void): IDisposable
    {
        return new ScheduledPoll(delayMs, poll)
    }
}
