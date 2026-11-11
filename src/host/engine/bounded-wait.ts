import { Disposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'

/** Runs `work` once after `delayMs` unless the returned handle is disposed first (the upgrade debounce). */
export interface IUpgradeTimer
{
    Start(delayMs: number, work: () => void): IDisposable
}

/**
 * A wait bounded by a timer seam: resolves true when `work` settles first, false when `ms` elapses first. A rejection of
 * `work` counts as settled (the caller only waits for it to stop).
 */
export class BoundedWait
{
    public static Within(work: Promise<unknown>, ms: number, timer: IUpgradeTimer): Promise<boolean>
    {
        return new Promise<boolean>(resolve =>
        {
            const handle = timer.Start(ms, () => resolve(false))
            const done = (): void =>
            {
                handle.dispose()
                resolve(true)
            }
            work.then(done, done)
        })
    }
}

export class TimeoutUpgradeTimer implements IUpgradeTimer
{
    public Start(delayMs: number, work: () => void): IDisposable
    {
        const handle = setTimeout(work, delayMs)
        // a pending recompile never keeps the process alive on its own
        handle.unref?.()
        return new Disposable(() => clearTimeout(handle))
    }
}
