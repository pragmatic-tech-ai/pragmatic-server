/** The kinds of tenant-scoped event the control plane fans out over the tenant events websocket. */
export enum TenantEventType
{
    EnvironmentCreated = 'environment-created',
    EnvironmentChanged = 'environment-changed',
    EnvironmentDeleted = 'environment-deleted',
    HealthChanged = 'health-changed'
}

/** A tenant-scoped event delivered to that tenant's subscribers only. Carries no secret and no cross-tenant data. */
export type TenantEvent = { type: TenantEventType; environmentName: string }

/**
 * Per-tenant event fan-out. Subscribers register under a `tenantId`; `Emit` delivers to that tenant's subscribers
 * ONLY and never to any other tenant. This is the sole upward seam the host uses to notify a tenant of changes to
 * its own environments; the operator broadcast is a separate, untouched channel.
 */
export class TenantEventBus
{
    private readonly subscribers = new Map<string, Set<(event: TenantEvent) => void>>()

    /** Registers a callback for one tenant and returns an unsubscribe that removes it (and prunes the empty set). */
    public On(tenantId: string, cb: (event: TenantEvent) => void): () => void
    {
        let set = this.subscribers.get(tenantId)
        if (set === undefined)
        {
            set = new Set<(event: TenantEvent) => void>()
            this.subscribers.set(tenantId, set)
        }
        set.add(cb)
        return () =>
        {
            const current = this.subscribers.get(tenantId)
            if (current === undefined)
            {
                return
            }
            current.delete(cb)
            if (current.size === 0)
            {
                this.subscribers.delete(tenantId)
            }
        }
    }

    /** Fans an event out to the named tenant's subscribers only. A snapshot is taken so a callback may unsubscribe mid-emit. */
    public Emit(tenantId: string, event: TenantEvent): void
    {
        const set = this.subscribers.get(tenantId)
        if (set === undefined)
        {
            return
        }
        for (const cb of [...set])
        {
            cb(event)
        }
    }
}
