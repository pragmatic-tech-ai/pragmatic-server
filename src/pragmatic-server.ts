import { LazyCompositionRoot, HostKinds, ModuleStateKind } from '@pragmatic-tech-ai/todl-runtime'
import { TenantPurpose } from './tenancy/tenant-purpose.js'
import type { ModuleStateProperty } from '@pragmatic-tech-ai/todl-runtime'
import { SolutionManagerService, StoragePackageSource, StoragePackageStore, PackageStoreKey } from '@pragmatic-tech-ai/todl'
import { NodeProjectSystemComposer } from '@pragmatic-tech-ai/todl/project-system'
import { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { SolutionServicesModule, LanguageServiceModule } from './composition/server-modules.js'
import type { MasterKeyRef } from './identity/master-key-resolver.js'
import type { IProvisionedSecretSource } from './config/provisioned-secret-source.js'
import { TenantConfigStoreKey } from '@pragmatic-tech-ai/todl-identity'
import type { Tenant, IdentityConfig, ITenantConfigStore } from '@pragmatic-tech-ai/todl-identity'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import type { IHttpClient, IOidcFlowStateStore } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { OidcFrontDoor } from './host/auth-http-endpoint.js'
import type { MachinePrincipalMap } from './host/machine-principal-map.js'
import { IdentityModule } from './identity/identity-module.js'
import { ServerBootstrap } from './identity/server-bootstrap.js'
import { DeploymentMode } from './platform/deployment-mode.js'
import { PlatformSelector } from './platform/platform-selector.js'
import type { PlatformServices } from './platform/platform-services.js'
import { ConnectorsHost } from '@pragmatic-tech-ai/todl-connectors-host'
import type { ConnectorsHostOptions } from '@pragmatic-tech-ai/todl-connectors-host'
import { SolutionConnectorPlanner } from './connectors/solution-connector-planner.js'
import { ConnectorRuntime } from './connectors/connector-runtime.js'
import { PolicyConnectionResolver } from './host/policy-connection-resolver.js'
import type { ConnectorsPolicy } from './host/connector-policy.js'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { PragmaticAppsRegistry } from './host/apps/pragmatic-apps-registry.js'
import { TenantGraphCache } from './host/cypher/tenant-graph-cache.js'
import type { TenantRepository } from './host/cypher/tenant-graph-source.js'

export interface OidcServerOptions
{
    issuer: string
    clientId: string
    clientSecretRef: string
    discoveryUrl: string
    redirectUri: string
    provider: string
}

export interface BootstrapOptions
{
    adminEmail: string
    adminPrincipalId: string
    adminPasswordRef: string
    ownerGrant: boolean
    allowAdminPasswordRotation?: boolean
}

export interface PragmaticServerIdentityOptions
{
    identityRoot: string
    masterKey: MasterKeyRef
    tenant: { id: string; displayName: string }
    oidc?: OidcServerOptions
    bootstrap?: BootstrapOptions
    provisionedSecrets?: IProvisionedSecretSource
    additionalSecretRefs?: readonly string[]
    identityConfig?: IdentityConfig
    machine?: MachinePrincipalMap
    httpClient?: IHttpClient
    flowStateStore?: IOidcFlowStateStore
}

export interface PragmaticServerOptions
{
    purpose?: TenantPurpose
    applicationsRoot?: string
    packagesRoot?: string
    identity?: PragmaticServerIdentityOptions
    deploymentMode?: DeploymentMode
    platform?: PlatformServices
    connectors?: ConnectorsHostOptions
    connectorsPolicy?: ConnectorsPolicy
}

/** Headless single-tenant in-process host: composes the engine over the lazy root and opens a solution. */
export class PragmaticServer
{
    private static readonly DefaultPackagesDir = 'packages'
    /** Default applications directory (relative to the process cwd) when `applicationsRoot` is not configured. */
    private static readonly DefaultApplicationsDir = 'applications'
    private static readonly ErrorSeparator = '; '

    private static readonly NotStartedError = 'server not started'
    private static readonly ApplicationsRuntimeOnlyError = 'applications are a runtime-tenant feature'
    private static readonly IdentityNotConfiguredError = 'identity not configured'
    private static readonly NoActiveSolutionForConnectors = 'No active solution: open a solution before accessing connectors'
    private static readonly NoMemberStorageForConnectors = 'Active solution has no member storage to read a model view from'
    private static readonly NoModelViewForConnectors = 'Active solution produced no model view'

    private static readonly GraphModelVersion = '0.0.0'

    private readonly root: LazyCompositionRoot
    private readonly options: PragmaticServerOptions
    private readonly platform: PlatformServices
    private readonly identity: IdentityModule | undefined
    private readonly connectorsHost: ConnectorsHost
    private disposing: Promise<void> | undefined
    private pack: ServerIdentityPack | undefined
    private tenant: Tenant | undefined
    private oidc: OidcFrontDoor | undefined
    private graphCache: TenantGraphCache | undefined
    private appsStorage: IStorage | undefined
    private appsRegistry: PragmaticAppsRegistry | undefined

    public constructor(options: PragmaticServerOptions)
    {
        this.options = options
        this.platform = PlatformSelector.Resolve(options.platform, options.deploymentMode ?? DeploymentMode.Local)
        this.identity = options.identity === undefined ? undefined : new IdentityModule(options.identity, this.platform)
        const builder = LazyCompositionRoot.Builder(HostKinds.Server)
            .Module(new SolutionServicesModule())
            .Module(new LanguageServiceModule())
        this.root = builder.Build()
        this.connectorsHost = new ConnectorsHost(PragmaticServer.ConnectorsOptions(options))
        this.RegisterInfrastructure(options.packagesRoot ?? PragmaticServer.DefaultPackagesDir)
    }

    private static ConnectorsOptions(options: PragmaticServerOptions): ConnectorsHostOptions | undefined
    {
        if (options.connectorsPolicy === undefined)
        {
            return options.connectors
        }
        const resolver = new PolicyConnectionResolver(options.connectorsPolicy, options.connectors?.connectionResolver)
        return { ...options.connectors, connectionResolver: resolver }
    }

    public async Start(): Promise<void>
    {
        const errors = await this.root.Start()
        if (errors.length > 0)
        {
            throw new Error(errors.map(e => String(e)).join(PragmaticServer.ErrorSeparator))
        }
        if (this.identity !== undefined)
        {
            try
            {
                const composed = await this.identity.ComposeAsync(this.root.Services())
                this.pack = composed.pack
                this.tenant = composed.tenant
                this.oidc = composed.oidc
            }
            catch (error)
            {
                this.root.Services().dispose()
                throw error
            }
        }
    }

    public async Pack(): Promise<ServerIdentityPack>
    {
        if (this.identity === undefined)
        {
            throw new Error(PragmaticServer.IdentityNotConfiguredError)
        }
        if (this.pack === undefined)
        {
            throw new Error(PragmaticServer.NotStartedError)
        }
        return this.pack
    }

    public async TenantConfigStore(): Promise<ITenantConfigStore>
    {
        if (this.identity === undefined)
        {
            throw new Error(PragmaticServer.IdentityNotConfiguredError)
        }
        if (this.pack === undefined)
        {
            throw new Error(PragmaticServer.NotStartedError)
        }
        return this.root.Resolve(TenantConfigStoreKey)
    }

    public Purpose(): TenantPurpose
    {
        return this.options.purpose ?? TenantPurpose.Development
    }

    public AppsStorage(): IStorage
    {
        this.appsStorage ??= this.platform.CreateStorage(this.options.applicationsRoot ?? PragmaticServer.DefaultApplicationsDir)
        return this.appsStorage
    }

    public Applications(): PragmaticAppsRegistry
    {
        if (this.Purpose() !== TenantPurpose.Runtime)
        {
            throw new Error(PragmaticServer.ApplicationsRuntimeOnlyError)
        }
        this.appsRegistry ??= new PragmaticAppsRegistry(this.AppsStorage())
        return this.appsRegistry
    }

    public Tenant(): Tenant
    {
        if (this.identity === undefined)
        {
            throw new Error(PragmaticServer.IdentityNotConfiguredError)
        }
        if (this.tenant === undefined)
        {
            throw new Error(PragmaticServer.NotStartedError)
        }
        return this.tenant
    }

    public Oidc(): OidcFrontDoor | undefined
    {
        return this.oidc
    }

    /** Test-only: re-runs the bootstrap seed (e.g. after pre-storing the admin password). */
    public async SeedBootstrapForTest(): Promise<void>
    {
        const bootstrap = this.options.identity?.bootstrap
        if (this.pack !== undefined && this.tenant !== undefined && bootstrap !== undefined)
        {
            await ServerBootstrap.SeedAsync(this.pack, this.tenant, bootstrap)
        }
    }

    public async Manager(): Promise<SolutionManagerService>
    {
        return this.root.Resolve(SolutionManagerService.Key)
    }

    public async LanguageService(): Promise<ILanguageService>
    {
        return this.root.Resolve(SolutionLanguageService.Key)
    }

    public async OpenSolution(location: string): Promise<void>
    {
        const manager = await this.Manager()
        await manager.OpenSolution(location)
    }

    public async Connectors(): Promise<ConnectorRuntime>
    {
        const manager = await this.Manager()
        const solution = manager.ActiveSolution
        if (solution === undefined)
        {
            throw new Error(PragmaticServer.NoActiveSolutionForConnectors)
        }
        const member = solution.Members.ToArray().find(m => m.Storage !== undefined)
        if (member === undefined || member.Storage === undefined)
        {
            throw new Error(PragmaticServer.NoMemberStorageForConnectors)
        }
        const languageService = await this.LanguageService()
        const view = await languageService.ModelView(member.Storage)
        if (view === undefined)
        {
            throw new Error(PragmaticServer.NoModelViewForConnectors)
        }
        const models = SolutionConnectorPlanner.Plan(view.model)
        return new ConnectorRuntime(models, this.root.Services())
    }

    /**
     * The queryable graph for `context` over the tenant's ACTIVE solution (its member projects),
     * RBAC-filtered per request. With no solution open the graph is empty. Session-scoped
     * multi-solution querying is deferred (future SSM program).
     * The solution view is ONE Repository shared by every member, so the sources are the distinct
     * repositories reachable from members with Storage (identity-deduped), pinned to the solution name.
     */
    public async Graph(context: AccessContext): Promise<IGraphQuery>
    {
        this.graphCache ??= new TenantGraphCache(() => this.CollectGraphSources())
        return await this.graphCache.GraphFor(context)
    }

    private async CollectGraphSources(): Promise<readonly TenantRepository[]>
    {
        const solution = (await this.Manager()).ActiveSolution
        if (solution === undefined)
        {
            return []
        }
        const languageService = await this.LanguageService()
        const sources: TenantRepository[] = []
        for (const member of solution.Members.ToArray())
        {
            if (member.Storage === undefined)
            {
                continue
            }
            const view = await languageService.ModelView(member.Storage)
            if (view !== undefined && !sources.some(s => s.repo === view.model))
            {
                sources.push({ repo: view.model, model: solution.Name, version: PragmaticServer.GraphModelVersion })
            }
        }
        return sources
    }

    public StateOf(moduleId: string): ModuleStateProperty | undefined
    {
        return this.root.StateOf(moduleId)
    }

    /** Idempotent: every call (concurrent or later) shares the one teardown. */
    public Dispose(): Promise<void>
    {
        this.disposing ??= this.DoDispose()
        return this.disposing
    }

    private async DoDispose(): Promise<void>
    {
        try
        {
            await this.connectorsHost.Dispose()
        }
        finally
        {
            this.graphCache?.Dispose()
            try
            {
                const disposable = this.options.identity?.flowStateStore as { Dispose?: () => Promise<void> } | undefined
                if (disposable?.Dispose !== undefined)
                {
                    await disposable.Dispose()
                }
            }
            finally
            {
                await this.DrainLanguageService()
                this.root.Services().dispose()
            }
        }
    }

    /** Awaits the language service's queued maintenance tail, only if it was already built; best-effort. */
    private async DrainLanguageService(): Promise<void>
    {
        if (this.root.StateOf(LanguageServiceModule.ModuleId)?.Get().Kind !== ModuleStateKind.Active)
        {
            return
        }
        try
        {
            const languageService = await this.LanguageService() as SolutionLanguageService
            await languageService.WhenIdle()
        }
        catch
        {
            // draining is best-effort; never block teardown on it
        }
    }

    private RegisterInfrastructure(packagesRoot: string): void
    {
        const services = this.root.Services()
        services.registerInstance(SolutionManagerService.StorageRegistryKey, this.platform.CreateStorageProviderRegistry())
        services.registerInstance(SolutionManagerService.PromptServiceKey, this.platform.CreatePromptService())
        const packagesStorage = this.platform.CreatePackagesStorage(packagesRoot)
        services.registerInstance(SolutionManagerService.PackageSourceKey, new StoragePackageSource(packagesStorage))
        services.registerInstance(PackageStoreKey, new StoragePackageStore(packagesStorage))
        NodeProjectSystemComposer.Compose(services)
        this.connectorsHost.Register(services)
    }
}
