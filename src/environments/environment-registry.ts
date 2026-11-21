import { join } from 'node:path'
import { PragmaticServer, type PragmaticServerOptions } from '../pragmatic-server.js'
import type { MasterKeyRef, DeploymentMode, AdapterPacksConfig } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import type { IProvisionedSecretSource } from '../config/provisioned-secret-source.js'
import type { PlatformServices } from '../platform/platform-services.js'
import type { IEnvironmentCoordinator } from './environment-coordinator.js'
import { InMemoryEnvironmentOwnership, EnvironmentOwnedElsewhereError, type IEnvironmentOwnership, type EnvironmentLostHandler } from './environment-ownership.js'
import type { IdentityRuntime } from '../identity/identity-runtime.js'
import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { IEnvironmentProvisioning, EnvironmentProvisioning } from './environment-provisioning.js'

export class InMemoryEnvironmentProvisioning implements IEnvironmentProvisioning
{
    private readonly entries: ReadonlyMap<string, EnvironmentProvisioning>

    public constructor(entries: ReadonlyMap<string, EnvironmentProvisioning>)
    {
        this.entries = entries
    }

    public OptionsFor(environmentId: string): EnvironmentProvisioning | null
    {
        return this.entries.get(environmentId) ?? null
    }
}

/** Owns one PragmaticServer per environment (separate composition root over environment-rooted storage).
 *  Spin-up on first use, idle-evict via the coordinator, never evict while connected. */
export class EnvironmentRegistry
{
    private static readonly PackagesDir = 'packages'
    private static readonly ApplicationsDir = 'applications'
    private static readonly GraphsDir = 'graphs'
    private static readonly SolutionsDir = 'solutions'
    private static readonly IdentityDir = 'identity'
    private static readonly UnprovisionedError = 'environment is not provisioned'
    private static readonly InvalidEnvironmentError = 'invalid environment id'
    private static readonly ParentSegment = '..'
    private static readonly SeparatorPattern = /[\\/:]/

    private readonly baseDir: string
    private readonly masterKey: MasterKeyRef
    private readonly provisioning: IEnvironmentProvisioning
    private readonly coordinator: IEnvironmentCoordinator
    private ownership: IEnvironmentOwnership
    private readonly provisionedSecrets: IProvisionedSecretSource | undefined
    private readonly lostDuringBuild = new Set<string>()
    private readonly identityRuntime: IdentityRuntime | undefined
    private readonly platform: PlatformServices | undefined
    private readonly adapterPacks: AdapterPacksConfig | undefined
    private readonly deploymentMode: DeploymentMode | undefined
    /** The host's logger, handed to every environment server it builds. */
    private readonly logger: ILogger | undefined
    private readonly servers = new Map<string, PragmaticServer>()
    private readonly pending = new Map<string, Promise<PragmaticServer>>()
    private readonly disposing = new Map<string, Promise<void>>()

    public constructor(baseDir: string, masterKey: MasterKeyRef, provisioning: IEnvironmentProvisioning, coordinator: IEnvironmentCoordinator, platform?: PlatformServices, deploymentMode?: DeploymentMode, ownership: IEnvironmentOwnership = new InMemoryEnvironmentOwnership(), provisionedSecrets?: IProvisionedSecretSource, identityRuntime?: IdentityRuntime, adapterPacks?: AdapterPacksConfig, logger?: ILogger)
    {
        this.adapterPacks = adapterPacks
        this.logger = logger
        this.baseDir = baseDir
        this.masterKey = masterKey
        this.provisioning = provisioning
        this.coordinator = coordinator
        this.platform = platform
        this.deploymentMode = deploymentMode
        this.ownership = ownership
        this.provisionedSecrets = provisionedSecrets
        this.identityRuntime = identityRuntime
        this.ownership.OnLost(environmentId => void this.DisposeEnvironment(environmentId))
    }

    public async ServerFor(environmentId: string): Promise<PragmaticServer>
    {
        const existing = this.servers.get(environmentId)
        if (existing !== undefined)
        {
            return existing
        }
        const inFlight = this.pending.get(environmentId)
        if (inFlight !== undefined)
        {
            return inFlight
        }
        const build = this.Build(environmentId)
        this.pending.set(environmentId, build)
        try
        {
            const server = await build
            if (this.lostDuringBuild.delete(environmentId))
            {
                await server.Dispose().catch(() => {})
                throw new EnvironmentOwnedElsewhereError()
            }
            this.servers.set(environmentId, server)
            this.coordinator.Note(environmentId)
            return server
        }
        finally
        {
            this.pending.delete(environmentId)
            this.lostDuringBuild.delete(environmentId)
        }
    }

    public Acquire(environmentId: string): void
    {
        this.coordinator.Acquire(environmentId)
    }

    public Release(environmentId: string): void
    {
        this.coordinator.Release(environmentId)
    }

    public async EvictIdle(nowMs: number, idleTtlMs: number): Promise<void>
    {
        for (const environmentId of this.coordinator.EvictCandidates(nowMs, idleTtlMs))
        {
            if (!this.coordinator.EvictCandidates(nowMs, idleTtlMs).includes(environmentId))
            {
                continue
            }
            const server = this.servers.get(environmentId)
            if (server === undefined)
            {
                continue
            }
            this.servers.delete(environmentId)
            this.coordinator.Forget(environmentId)
            const tracked = server.Dispose()
                .catch(() => {})
                .then(() => this.ownership.Release(environmentId).catch(() => {}))
                .finally(() => this.disposing.delete(environmentId))
            this.disposing.set(environmentId, tracked)
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
        this.ownership.OnLost(environmentId => void this.DisposeEnvironment(environmentId))
    }

    /** Fail-closed response to a lost lease: drop the local server so this replica stops writing the environment.
     *  The ownership key is already gone, so no Release is issued. */
    public async DisposeEnvironment(environmentId: string): Promise<void>
    {
        const server = this.servers.get(environmentId)
        if (server === undefined)
        {
            if (this.pending.has(environmentId))
            {
                this.lostDuringBuild.add(environmentId)
            }
            return
        }
        this.servers.delete(environmentId)
        this.coordinator.Forget(environmentId)
        const disposal = server.Dispose().catch(() => {})
        const tracked = disposal.finally(() => this.disposing.delete(environmentId))
        this.disposing.set(environmentId, tracked)
        await tracked
    }

    private async Build(environmentId: string): Promise<PragmaticServer>
    {
        if (environmentId === '' || environmentId === '.' || environmentId === EnvironmentRegistry.ParentSegment || EnvironmentRegistry.SeparatorPattern.test(environmentId))
        {
            throw new Error(EnvironmentRegistry.InvalidEnvironmentError)
        }
        const provisioning = this.provisioning.OptionsFor(environmentId)
        if (provisioning === null)
        {
            throw new Error(EnvironmentRegistry.UnprovisionedError)
        }
        const disposing = this.disposing.get(environmentId)
        if (disposing !== undefined)
        {
            await disposing
        }
        if (!await this.ownership.Acquire(environmentId))
        {
            throw new EnvironmentOwnedElsewhereError()
        }
        try
        {
            const server = new PragmaticServer(this.OptionsFor(environmentId, provisioning))
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
            await this.ownership.Release(environmentId).catch(() => {})
            throw error
        }
    }

    /** Package-visible for tests; Build validates the environment id before calling (it is used verbatim in flow-state key prefixes). */
    public OptionsFor(environmentId: string, provisioning: EnvironmentProvisioning): PragmaticServerOptions
    {
        return {
            packagesRoot: join(this.baseDir, environmentId, EnvironmentRegistry.PackagesDir),
            purpose: provisioning.purpose,
            runtimeCoHosted: provisioning.runtimeCoHosted,
            applicationsRoot: join(this.baseDir, environmentId, EnvironmentRegistry.ApplicationsDir),
            graphsRoot: join(this.baseDir, environmentId, EnvironmentRegistry.GraphsDir),
            solutionsRoot: join(this.baseDir, environmentId, EnvironmentRegistry.SolutionsDir),
            platform: this.platform,
            deploymentMode: this.deploymentMode,
            connectorsPolicy: provisioning.connectorsPolicy,
            connectors: provisioning.connectors,
            adapterPacks: this.adapterPacks,
            writeLock: this.ownership.WriteLock?.(environmentId),
            ...(this.logger === undefined ? {} : { logger: this.logger }),
            identity: {
                identityRoot: join(this.baseDir, environmentId, EnvironmentRegistry.IdentityDir),
                masterKey: this.masterKey,
                environment: { id: environmentId, displayName: provisioning.displayName },
                bootstrap: provisioning.bootstrap,
                oidc: provisioning.oidc,
                provisionedSecrets: this.provisionedSecrets,
                additionalSecretRefs: provisioning.connectorSecretRefs,
                identityConfig: provisioning.identity,
                machine: provisioning.machine,
                httpClient: this.identityRuntime?.HttpClient,
                flowStateStore: this.identityRuntime?.FlowStateFor(environmentId),
            },
        }
    }
}

/** Deterministic in-process ownership for tests: grants or denies per flags, never loses. */
class FixedOwnership implements IEnvironmentOwnership
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

    public async Acquire(_environmentId: string): Promise<boolean>
    {
        return this.granted
    }

    public async Release(_environmentId: string): Promise<void>
    {
    }

    public async ReleaseAll(): Promise<void>
    {
    }

    public Healthy(): boolean
    {
        return this.healthy
    }

    public OnLost(_handler: EnvironmentLostHandler): void
    {
    }
}
