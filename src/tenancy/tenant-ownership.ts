export type TenantLostHandler = (environmentId: string) => void

/** Cross-replica single-writer ownership of a tenant. Async because the SaaS impl (Redis) does network I/O;
 *  distinct from the per-replica synchronous ITenantCoordinator (connection-refcount / idle-evict). */
export interface ITenantOwnership
{
    Start(): Promise<void>
    Acquire(environmentId: string): Promise<boolean>
    Release(environmentId: string): Promise<void>
    ReleaseAll(): Promise<void>
    Healthy(): boolean
    OnLost(handler: TenantLostHandler): void
}

/** Thrown by TenantRegistry when another replica owns the requested tenant. The front door maps it to a retryable reject. */
export class TenantOwnedElsewhereError extends Error
{
    private static readonly MessageText = 'tenant owned by another replica'
    private static readonly ErrorName = 'TenantOwnedElsewhereError'

    public constructor()
    {
        super(TenantOwnedElsewhereError.MessageText)
        this.name = TenantOwnedElsewhereError.ErrorName
    }
}

/** Single-replica / no-Redis ownership: grants everything, never loses, always healthy.
 *  Selected when no Redis URL is configured, keeping single-replica behavior unchanged. */
export class InMemoryTenantOwnership implements ITenantOwnership
{
    public async Start(): Promise<void>
    {
    }

    public async Acquire(_tenantId: string): Promise<boolean>
    {
        return true
    }

    public async Release(_tenantId: string): Promise<void>
    {
    }

    public async ReleaseAll(): Promise<void>
    {
    }

    public Healthy(): boolean
    {
        return true
    }

    public OnLost(_handler: TenantLostHandler): void
    {
    }
}
