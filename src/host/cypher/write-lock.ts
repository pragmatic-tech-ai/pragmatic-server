import { AsyncMutex } from './async-mutex.js'

/** One held tenant write lease. `Held` re-verifies ownership at the moment it is asked (the fencing check before a persist). */
export interface IWriteLease
{
    Held(): Promise<boolean>
    Release(): Promise<void>
}

/** A tenant's write lock: at most one lease is held at a time across every process that serves the tenant. */
export interface IWriteLock
{
    /** Waits (bounded) for the lease; rejects with WriteLockBusyError when it stays held elsewhere or the lock service is unreachable. */
    Acquire(): Promise<IWriteLease>
}

/** The tenant write lease could not be obtained in time (another worker is writing, or the lock service is unreachable). */
export class WriteLockBusyError extends Error
{
    private static readonly MessageText = 'another write to this tenant is in progress'
    private static readonly ErrorName = 'WriteLockBusyError'

    constructor()
    {
        super(WriteLockBusyError.MessageText)
        this.name = WriteLockBusyError.ErrorName
    }
}

/** Single-process lock: correct when one process serves the tenant (no cluster coordination configured). */
export class InProcessWriteLock implements IWriteLock
{
    private readonly mutex = new AsyncMutex()

    public Acquire(): Promise<IWriteLease>
    {
        return new Promise<IWriteLease>((resolveLease, rejectLease) =>
        {
            this.mutex.Run(() => new Promise<void>(release =>
            {
                resolveLease(new InProcessWriteLease(release))
            })).catch(rejectLease)
        })
    }
}

class InProcessWriteLease implements IWriteLease
{
    private released = false

    constructor(private readonly release: () => void)
    {
    }

    public async Held(): Promise<boolean>
    {
        return !this.released
    }

    public async Release(): Promise<void>
    {
        if (this.released) return
        this.released = true
        this.release()
    }
}
