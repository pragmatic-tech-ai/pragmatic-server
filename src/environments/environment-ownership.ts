import type { IWriteLock } from '../host/cypher/write-lock.js'

export type EnvironmentLostHandler = (environmentId: string) => void

/** Cross-replica single-writer ownership of an environment. Async because the SaaS impl (Redis) does network I/O;
 *  distinct from the per-replica synchronous IEnvironmentCoordinator (connection-refcount / idle-evict). */
export interface IEnvironmentOwnership
{
    Start(): Promise<void>
    Acquire(environmentId: string): Promise<boolean>
    Release(environmentId: string): Promise<void>
    ReleaseAll(): Promise<void>
    Healthy(): boolean
    OnLost(handler: EnvironmentLostHandler): void
    /** Optional: the cross-process write lock for one environment. Absent => the server's in-process lock suffices (single replica). */
    WriteLock?(environmentId: string): IWriteLock
}

/** Thrown by EnvironmentRegistry when another replica owns the requested environment. The front door maps it to a retryable reject. */
export class EnvironmentOwnedElsewhereError extends Error
{
    private static readonly MessageText = 'environment owned by another replica'
    private static readonly ErrorName = 'EnvironmentOwnedElsewhereError'

    public constructor()
    {
        super(EnvironmentOwnedElsewhereError.MessageText)
        this.name = EnvironmentOwnedElsewhereError.ErrorName
    }
}

/** Single-replica / no-Redis ownership: grants everything, never loses, always healthy.
 *  Selected when no Redis URL is configured, keeping single-replica behavior unchanged. */
export class InMemoryEnvironmentOwnership implements IEnvironmentOwnership
{
    public async Start(): Promise<void>
    {
    }

    public async Acquire(_environmentId: string): Promise<boolean>
    {
        return true
    }

    public async Release(_environmentId: string): Promise<void>
    {
    }

    public async ReleaseAll(): Promise<void>
    {
    }

    public Healthy(): boolean
    {
        return true
    }

    public OnLost(_handler: EnvironmentLostHandler): void
    {
    }
}
