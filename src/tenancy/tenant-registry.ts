import { join } from 'node:path'
import { PragmaticServer } from '../pragmatic-server.js'
import type { PragmaticServerOptions } from '../pragmatic-server.js'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import type { ITenantCoordinator } from './tenant-coordinator.js'
import type { ITenantProvisioning, TenantProvisioning } from './tenant-provisioning.js'

export class InMemoryTenantProvisioning implements ITenantProvisioning
{
    private readonly entries: ReadonlyMap<string, TenantProvisioning>

    public constructor(entries: ReadonlyMap<string, TenantProvisioning>)
    {
        this.entries = entries
    }

    public OptionsFor(tenantId: string): TenantProvisioning | null
    {
        return this.entries.get(tenantId) ?? null
    }
}

/** Owns one PragmaticServer per tenant (separate composition root over tenant-rooted storage).
 *  Spin-up on first use, idle-evict via the coordinator, never evict while connected. */
export class TenantRegistry
{
    private static readonly PackagesDir = 'packages'
    private static readonly IdentityDir = 'identity'
    private static readonly UnprovisionedError = 'tenant is not provisioned'
    private static readonly InvalidTenantError = 'invalid tenant id'
    private static readonly ParentSegment = '..'
    private static readonly SeparatorPattern = /[\\/]/

    private readonly baseDir: string
    private readonly masterKey: MasterKeyRef
    private readonly provisioning: ITenantProvisioning
    private readonly coordinator: ITenantCoordinator
    private readonly servers = new Map<string, PragmaticServer>()
    private readonly pending = new Map<string, Promise<PragmaticServer>>()
    private readonly disposing = new Map<string, Promise<void>>()

    public constructor(baseDir: string, masterKey: MasterKeyRef, provisioning: ITenantProvisioning, coordinator: ITenantCoordinator)
    {
        this.baseDir = baseDir
        this.masterKey = masterKey
        this.provisioning = provisioning
        this.coordinator = coordinator
    }

    public async ServerFor(tenantId: string): Promise<PragmaticServer>
    {
        const existing = this.servers.get(tenantId)
        if (existing !== undefined)
        {
            return existing
        }
        const inFlight = this.pending.get(tenantId)
        if (inFlight !== undefined)
        {
            return inFlight
        }
        const build = this.Build(tenantId)
        this.pending.set(tenantId, build)
        try
        {
            const server = await build
            this.servers.set(tenantId, server)
            this.coordinator.Note(tenantId)
            return server
        }
        finally
        {
            this.pending.delete(tenantId)
        }
    }

    public Acquire(tenantId: string): void
    {
        this.coordinator.Acquire(tenantId)
    }

    public Release(tenantId: string): void
    {
        this.coordinator.Release(tenantId)
    }

    public async EvictIdle(nowMs: number, idleTtlMs: number): Promise<void>
    {
        for (const tenantId of this.coordinator.EvictCandidates(nowMs, idleTtlMs))
        {
            if (!this.coordinator.EvictCandidates(nowMs, idleTtlMs).includes(tenantId))
            {
                continue
            }
            const server = this.servers.get(tenantId)
            if (server === undefined)
            {
                continue
            }
            this.servers.delete(tenantId)
            this.coordinator.Forget(tenantId)
            const disposal = server.Dispose()
            const tracked = disposal.catch(() => {}).finally(() => this.disposing.delete(tenantId))
            this.disposing.set(tenantId, tracked)
            await tracked
        }
    }

    public async DisposeAll(): Promise<void>
    {
        await Promise.allSettled([...this.pending.values()])
        const servers = [...this.servers.values()]
        this.servers.clear()
        for (const server of servers)
        {
            await server.Dispose().catch(() => {})
        }
        await Promise.allSettled([...this.disposing.values()])
    }

    private async Build(tenantId: string): Promise<PragmaticServer>
    {
        if (tenantId === '' || tenantId === '.' || tenantId === TenantRegistry.ParentSegment || TenantRegistry.SeparatorPattern.test(tenantId))
        {
            throw new Error(TenantRegistry.InvalidTenantError)
        }
        const provisioning = this.provisioning.OptionsFor(tenantId)
        if (provisioning === null)
        {
            throw new Error(TenantRegistry.UnprovisionedError)
        }
        const disposing = this.disposing.get(tenantId)
        if (disposing !== undefined)
        {
            await disposing
        }
        const server = new PragmaticServer(this.OptionsFor(tenantId, provisioning))
        try
        {
            await server.Start()
        }
        catch (error)
        {
            await server.Dispose().catch(() => {})
            throw error
        }
        return server
    }

    private OptionsFor(tenantId: string, provisioning: TenantProvisioning): PragmaticServerOptions
    {
        return {
            packagesRoot: join(this.baseDir, tenantId, TenantRegistry.PackagesDir),
            identity: {
                identityRoot: join(this.baseDir, tenantId, TenantRegistry.IdentityDir),
                masterKey: this.masterKey,
                tenant: { id: tenantId, displayName: provisioning.displayName },
                bootstrap: provisioning.bootstrap,
                oidc: provisioning.oidc,
            },
        }
    }
}
