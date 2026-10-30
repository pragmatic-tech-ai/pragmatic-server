import { IdpStatus } from './idp-record.js'
import type { IdpRecord } from './idp-record.js'
import type { IdpRegistry } from './idp-registry.js'
import type { IdpConnection, IIdpWorkloadDriver } from './idp-workload-driver.js'

export type { IdpConnection } from './idp-workload-driver.js'

export interface IIdpService
{
    EnsureForTenant(tenantId: string, displayName: string): Promise<IdpConnection>

    /** Discards the tenant's per-tenant IdP and forgets its record; a tenant with no IdP record is a safe no-op. */
    TeardownForTenant(tenantId: string): Promise<void>
}

export class InvalidTenantIdError extends Error
{
    private static readonly ErrorName = 'InvalidTenantIdError'

    public constructor(message: string)
    {
        super(message)
        this.name = InvalidTenantIdError.ErrorName
    }
}

/** Per-tenant IdP entry point: validates, serializes per tenant, delegates the launch to the injected workload driver, then persists the driver's record. */
export class IdpService implements IIdpService
{
    private static readonly TenantIdPattern = /^[A-Za-z0-9-]+$/
    private static readonly InvalidTenantId = 'IdpService: invalid tenantId (only letters, digits and hyphens allowed)'

    private readonly locks = new Map<string, Promise<unknown>>()

    public constructor(
        private readonly registry: IdpRegistry,
        private readonly driver: IIdpWorkloadDriver)
    {
    }

    public async EnsureForTenant(tenantId: string, displayName: string): Promise<IdpConnection>
    {
        if (!IdpService.TenantIdPattern.test(tenantId))
        {
            throw new InvalidTenantIdError(IdpService.InvalidTenantId)
        }
        return await this.Serialized(tenantId, () => this.EnsureLocked(tenantId, displayName))
    }

    public async TeardownForTenant(tenantId: string): Promise<void>
    {
        await this.Serialized(tenantId, () => this.TeardownLocked(tenantId))
    }

    private async Serialized<T>(tenantId: string, work: () => Promise<T>): Promise<T>
    {
        const previous = this.locks.get(tenantId) ?? Promise.resolve()
        const run = previous.catch(() => undefined).then(work)
        this.locks.set(tenantId, run)
        try
        {
            return await run
        }
        finally
        {
            if (this.locks.get(tenantId) === run)
            {
                this.locks.delete(tenantId)
            }
        }
    }

    private async TeardownLocked(tenantId: string): Promise<void>
    {
        await this.registry.Load()
        const record = this.registry.Get(tenantId)
        if (record === undefined)
        {
            return
        }
        // Discard first: if it throws the record stays, so the delete can be retried (fail-closed).
        await this.driver.Discard(record)
        await this.registry.Delete(tenantId)
    }

    private async EnsureLocked(tenantId: string, displayName: string): Promise<IdpConnection>
    {
        await this.registry.Load()
        const existing = this.registry.Get(tenantId)
        // Only the launch path allocates a port; reuse/recover keep the record's own.
        const launching = existing === undefined || existing.status !== IdpStatus.Running
        const takenPorts = launching ? this.registry.List().map(r => r.port) : []
        const result = await this.driver.EnsureRunning({ tenantId, displayName, existing, takenPorts })
        if (result.record !== existing)
        {
            await this.PersistOrDiscard(result.record)
        }
        return result.connection
    }

    private async PersistOrDiscard(record: IdpRecord): Promise<void>
    {
        try
        {
            await this.registry.Put(record)
        }
        catch (err)
        {
            await this.driver.Discard(record)
            throw err
        }
    }
}
