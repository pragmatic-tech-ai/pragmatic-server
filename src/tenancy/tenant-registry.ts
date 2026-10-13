import { join } from 'node:path'
import { PragmaticServer } from '../pragmatic-server.js'
import type { PragmaticServerOptions } from '../pragmatic-server.js'
import type { MasterKeyRef } from '../identity/master-key-resolver.js'
import type { IProvisionedSecretSource } from '../config/provisioned-secret-source.js'
import type { PlatformServices } from '../platform/platform-services.js'
import type { DeploymentMode } from '../platform/deployment-mode.js'
import type { ITenantCoordinator } from './tenant-coordinator.js'
import { InMemoryTenantOwnership, TenantOwnedElsewhereError } from './tenant-ownership.js'
import type { ITenantOwnership, TenantLostHandler } from './tenant-ownership.js'
import type { IdentityRuntime } from '../identity/identity-runtime.js'
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
    private static readonly SeparatorPattern = /[\\/:]/

    private readonly baseDir: string
    private readonly masterKey: MasterKeyRef
    private readonly provisioning: ITenantProvisioning
    private readonly coordinator: ITenantCoordinator
    private ownership: ITenantOwnership
    private readonly provisionedSecrets: IProvisionedSecretSource | undefined
    private readonly lostDuringBuild = new Set<string>()
    private readonly identityRuntime: IdentityRuntime | undefined
    private readonly platform: PlatformServices | undefined
    private readonly deploymentMode: DeploymentMode | undefined
    private readonly servers = new Map<string, PragmaticServer>()
    private readonly pending = new Map<string, Promise<PragmaticServer>>()
    private readonly disposing = new Map<string, Promise<void>>()

    public constructor(baseDir: string, masterKey: MasterKeyRef, provisioning: ITenantProvisioning, coordinator: ITenantCoordinator, platform?: PlatformServices, deploymentMode?: DeploymentMode, ownership: ITenantOwnership = new InMemoryTenantOwnership(), provisionedSecrets?: IProvisionedSecretSource, identityRuntime?: IdentityRuntime)
    {
        this.baseDir = baseDir
        this.masterKey = masterKey
        this.provisioning = provisioning
        this.coordinator = coordinator
        this.platform = platform
        this.deploymentMode = deploymentMode
        this.ownership = ownership
        this.provisionedSecrets = provisionedSecrets
        this.identityRuntime = identityRuntime
        this.ownership.OnLost(tenantId => void this.DisposeTenant(tenantId))
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
            if (this.lostDuringBuild.delete(tenantId))
            {
                await server.Dispose().catch(() => {})
                throw new TenantOwnedElsewhereError()
            }
            this.servers.set(tenantId, server)
            this.coordinator.Note(tenantId)
            return server
        }
        finally
        {
            this.pending.delete(tenantId)
            this.lostDuringBuild.delete(tenantId)
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
            const tracked = server.Dispose()
                .catch(() => {})
                .then(() => this.ownership.Release(tenantId).catch(() => {}))
                .finally(() => this.disposing.delete(tenantId))
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
        await this.ownership.ReleaseAll().catch(() => {})
        await Promise.allSettled([...this.disposing.values()])
    }

    public OwnershipHealthy(): boolean
    {
        return this.ownership.Healthy()
    }

    /** Test seam: replace the ownership with a deterministic in-process grant/deny, re-wiring the lost handler. */
    public SetOwnershipForTest(granted: boolean, healthy = true): void
    {
        this.ownership = new FixedOwnership(granted, healthy)
        this.ownership.OnLost(tenantId => void this.DisposeTenant(tenantId))
    }

    /** Fail-closed response to a lost lease: drop the local server so this replica stops writing the tenant.
     *  The ownership key is already gone, so no Release is issued. */
    public async DisposeTenant(tenantId: string): Promise<void>
    {
        const server = this.servers.get(tenantId)
        if (server === undefined)
        {
            if (this.pending.has(tenantId))
            {
                this.lostDuringBuild.add(tenantId)
            }
            return
        }
        this.servers.delete(tenantId)
        this.coordinator.Forget(tenantId)
        const disposal = server.Dispose().catch(() => {})
        const tracked = disposal.finally(() => this.disposing.delete(tenantId))
        this.disposing.set(tenantId, tracked)
        await tracked
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
        if (!await this.ownership.Acquire(tenantId))
        {
            throw new TenantOwnedElsewhereError()
        }
        try
        {
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
        catch (error)
        {
            await this.ownership.Release(tenantId).catch(() => {})
            throw error
        }
    }

    /** Package-visible for tests; Build validates the tenant id before calling (it is used verbatim in flow-state key prefixes). */
    public OptionsFor(tenantId: string, provisioning: TenantProvisioning): PragmaticServerOptions
    {
        return {
            packagesRoot: join(this.baseDir, tenantId, TenantRegistry.PackagesDir),
            platform: this.platform,
            deploymentMode: this.deploymentMode,
            connectorsPolicy: provisioning.connectorsPolicy,
            connectors: provisioning.connectors,
            identity: {
                identityRoot: join(this.baseDir, tenantId, TenantRegistry.IdentityDir),
                masterKey: this.masterKey,
                tenant: { id: tenantId, displayName: provisioning.displayName },
                bootstrap: provisioning.bootstrap,
                oidc: provisioning.oidc,
                provisionedSecrets: this.provisionedSecrets,
                additionalSecretRefs: provisioning.connectorSecretRefs,
                identityConfig: provisioning.identity,
                machine: provisioning.machine,
                httpClient: this.identityRuntime?.HttpClient,
                flowStateStore: this.identityRuntime?.FlowStateFor(tenantId),
            },
        }
    }
}

/** Deterministic in-process ownership for tests: grants or denies per flags, never loses. */
class FixedOwnership implements ITenantOwnership
{
    private readonly granted: boolean
    private readonly healthy: boolean

    public constructor(granted: boolean, healthy: boolean)
    {
        this.granted = granted
        this.healthy = healthy
    }

    public async Start(): Promise<void>
    {
    }

    public async Acquire(_tenantId: string): Promise<boolean>
    {
        return this.granted
    }

    public async Release(_tenantId: string): Promise<void>
    {
    }

    public async ReleaseAll(): Promise<void>
    {
    }

    public Healthy(): boolean
    {
        return this.healthy
    }

    public OnLost(_handler: TenantLostHandler): void
    {
    }
}
