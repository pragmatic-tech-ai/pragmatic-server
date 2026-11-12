import { join } from 'node:path'
import { ConnectorContext, StorageKind } from '@pragmatic-tech-ai/graph'
import type { ISubscription } from '@pragmatic-tech-ai/graph'
import { LazyCompositionRoot, HostKinds, ModuleStateKind } from '@pragmatic-tech-ai/todl-runtime'
import { TenantPurpose } from './tenancy/tenant-purpose.js'
import type { ModuleStateProperty } from '@pragmatic-tech-ai/todl-runtime'
import { DataSourceAdapterCatalog, SolutionManagerService, StoragePackageSource, StoragePackageStore, PackageStoreKey } from '@pragmatic-tech-ai/todl'
import type { IDataSourceAdapterProvider, IDataSourceAdapterFactory } from '@pragmatic-tech-ai/todl'
import { NodeProjectSystemComposer } from '@pragmatic-tech-ai/todl/project-system'
import { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { SolutionServicesModule, LanguageServiceModule } from './composition/server-modules.js'
import type { MasterKeyRef } from './identity/master-key-resolver.js'
import type { IProvisionedSecretSource } from './config/provisioned-secret-source.js'
import { TenantConfigStoreKey } from '@pragmatic-tech-ai/todl-identity'
import type { Tenant, IdentityConfig, ITenantConfigStore } from '@pragmatic-tech-ai/todl-identity'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { UpstreamTokenVault } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { IHttpClient, IOidcFlowStateStore } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { OidcFrontDoor } from './host/auth-http-endpoint.js'
import type { MachinePrincipalMap } from './host/machine-principal-map.js'
import { IdentityModule } from './identity/identity-module.js'
import { ServerBootstrap } from './identity/server-bootstrap.js'
import { DeploymentMode } from './platform/deployment-mode.js'
import { PlatformSelector } from './platform/platform-selector.js'
import type { PlatformServices } from './platform/platform-services.js'
import { ConnectorsHost, NpmAdapterPackProvider, WorkerThreadSandboxFactory, ChildProcessSandboxFactory, SqlAdapterFactory, RestAdapterFactory, CypherAdapterFactory, DocumentAdapterFactory } from '@pragmatic-tech-ai/todl-connectors-host'
import { CallerCredentialAdapterProvider } from './host/connectors/caller-credential-adapter-factory.js'
import { CallerCredentials } from './host/connectors/caller-credentials.js'
import type { ICallerCredentialRevoker } from './host/connectors/caller-credentials.js'
import { CallerConnectorContext } from './host/engine/caller-connector-context.js'
import { SystemPrincipalScope } from './host/environment/system-principal-scope.js'
import { SandboxStrategy } from './config/server-config.js'
import type { AdapterPacksConfig } from './config/server-config.js'
import type { ConnectorsHostOptions } from '@pragmatic-tech-ai/todl-connectors-host'
import { PolicyConnectionResolver } from './host/policy-connection-resolver.js'
import type { ConnectorsPolicy } from './host/connector-policy.js'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { EngineConnectorService } from './host/engine/engine-connector-service.js'
import { RuntimeWritePayloadValidator } from './host/runtime-write-payload-validator.js'
import type { AppWriteOpDto, AppWriteResultDto, ShareParams, ShareResultDto, UnshareParams, UnshareResultDto, ListSharesParams, ListSharesResultDto, AssignParams, AssignResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import { InProcessWriteLock, type IWriteLock } from './host/cypher/write-lock.js'
import { DeliveryChannel, EnvironmentCatalogError } from '@pragmatic-tech-ai/todl/engine'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { CypherAppDeployParamsDto, AppDeployResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DevCypherExecute, LoggerDevExecuteDiagnostics } from './host/engine/dev-cypher-execute.js'
import { LoggerExecuteDiagnostics } from './host/engine/graph-cypher-execute.js'
import { PragmaticAppsRegistry } from './host/apps/pragmatic-apps-registry.js'
import { NullLogger, StructuredLogger } from './observability/logger.js'
import type { ILogger } from './observability/logger.js'
import { AppIngestService } from './host/apps/app-ingest-service.js'
import { DevGraphStore } from './host/graphs/dev-graph-store.js'
import { GraphPackageIngest } from './host/graphs/graph-package-ingest.js'
import { GraphPackageReader } from './host/graphs/graph-package-reader.js'
import { DevGraphService, type IDevGraphService } from './host/graphs/dev-graph-service.js'
import { DevGraphEngineHost, LoggerDevEngineDiagnostics } from './host/engine/dev-graph-engine-host.js'
import { LoggerDevWriteDiagnostics } from './host/engine/server-model-workspace.js'
import type { IDevGraphEngine } from './host/engine/dev-graph-engine-host.js'
import { AccessScopeSource, LoggerScopeDiagnostics } from './host/engine/access-scope-source.js'
import type { IGraphScope } from './host/engine/access-scope-source.js'
import { DevScopeRules } from './host/engine/dev-scope-rules.js'
import { EngineCypherQuery } from './host/engine/engine-cypher-query.js'
import { DevModelView, LoggerDevModelViewDiagnostics } from './host/engine/dev-model-view.js'
import { PromoteRecordStore } from './host/environment/promote-record-store.js'
import { EnvironmentDeliveries } from './host/environment/environment-deliveries.js'
import { EnvironmentEngineHost, EnvironmentUpgradeFailedError, LoggerEnvironmentDiagnostics } from './host/environment/environment-engine-host.js'
import type { IEnvironmentGraphHost } from './host/environment/environment-engine-host.js'
import { EnvironmentCypherExecute } from './host/environment/environment-cypher-execute.js'
import { EnvironmentModelView } from './host/environment/environment-model-view.js'
import { EnvironmentDataWriter } from './host/environment/environment-data-writer.js'
import { DataChangedPush, LoggerDataChangedDiagnostics } from './host/environment/data-changed-push.js'
import { EnvironmentShareService } from './host/environment/environment-share-service.js'
import { EnvironmentAssignService } from './host/environment/environment-assign-service.js'
import { EnvironmentScopeRules } from './host/environment/environment-scope-rules.js'
import type { IEnvironmentTier1 } from './host/environment/environment-scope-rules.js'
import { EnvironmentSecuritySetting, LoggerSecuritySettingDiagnostics } from './host/environment/environment-security-setting.js'
import { EnvironmentSecurityAdmin } from './host/environment/environment-security-admin.js'
import { DeliverySecurity } from './host/environment/delivery-security.js'
import { LoggerSecurityChangeLogDiagnostics, SecurityChangeLog } from './host/environment/security-change-log.js'
import { PendingBackfillStore } from './host/environment/pending-backfill-store.js'
import { TimeoutUpgradeTimer } from './host/engine/bounded-wait.js'
import { IdpDirectorySyncHost } from './host/environment/idp-directory-sync-host.js'
import { IdpDirectorySync } from '@pragmatic-tech-ai/todl-identity'
import type { ISecuritySettingAdmin } from './host/admin-service.js'
import { InvalidParamsPrefix } from './host/invalid-params-prefix.js'
import type { GraphLoadParamsDto, GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'

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
    /**
     * Whether a Runtime tenant starts its IdP directory sync at Start (default true). Only a host that drives the sync
     * itself sets false (tests over synthetic principals that have no accounts, which an authoritative local directory
     * would deprovision).
     */
    directorySyncOnStart?: boolean
}

export interface PragmaticServerOptions
{
    purpose?: TenantPurpose
    applicationsRoot?: string
    packagesRoot?: string
    graphsRoot?: string
    identity?: PragmaticServerIdentityOptions
    deploymentMode?: DeploymentMode
    platform?: PlatformServices
    connectors?: ConnectorsHostOptions
    connectorsPolicy?: ConnectorsPolicy
    readonly adapterPacks?: AdapterPacksConfig
    /** Cross-process tenant write lock (cluster); absent => in-process only, correct for a single replica. */
    writeLock?: IWriteLock
    /** The host's logger (dev access-scope diagnostics, ...); absent => nothing is logged. */
    logger?: ILogger
    /** The runtime environment engine's store kind (ruling S2); absent => LMDB at `<graphsRoot>/environment-engine`. */
    environmentEngineStorage?: StorageKind
    /**
     * Extra data-source adapter factories registered on this tenant's adapter catalog after the built-in ones (a factory
     * replaces the built-in one of its kind); absent => the built-ins only. Test sources plug in here.
     */
    adapterFactories?: readonly IDataSourceAdapterFactory[]
}

/** Headless single-tenant in-process host: composes the engine over the lazy root and opens a solution. */
export class PragmaticServer implements IEnvironmentGraphHost
{
    private static readonly DefaultPackagesDir = 'packages'
    private static readonly DefaultGraphsDir = 'graphs'
    private static readonly ApplicationsRootRequiredError = 'applicationsRoot is required for a runtime tenant'
    private static readonly ErrorSeparator = '; '

    private static readonly SharingRequiresIdentityError = 'record sharing requires an identity subsystem'
    private static readonly AssignRequiresIdentityError = 'record assignment requires an identity subsystem'
    private static readonly NotStartedError = 'server not started'
    private static readonly ApplicationsRuntimeOnlyError = 'applications are a runtime-tenant feature'
    private static readonly IdentityNotConfiguredError = 'identity not configured'

    private static readonly NotDevelopmentMessage = 'operation requires a development tenant'
    private static readonly DisposedMessage = 'The server has been disposed'
    private static readonly DirectorySyncStartFailedLine = 'directory sync: start failed: '
    private static readonly UnknownErrorName = 'unknown'

    private readonly root: LazyCompositionRoot
    private readonly options: PragmaticServerOptions
    private readonly platform: PlatformServices
    private readonly identity: IdentityModule | undefined
    private readonly connectorsHost: ConnectorsHost
    private readonly callerCredentials: CallerCredentials
    private disposing: Promise<void> | undefined
    private pack: ServerIdentityPack | undefined
    private tenant: Tenant | undefined
    private oidc: OidcFrontDoor | undefined
    private appsStorage: IStorage | undefined
    private appsRegistry: PragmaticAppsRegistry | undefined
    private appIngest: AppIngestService | undefined
    private devGraphService: IDevGraphService | undefined
    private devEngine: DevGraphEngineHost | undefined
    private devScopes: Promise<AccessScopeSource> | undefined
    private devCypher: EngineCypherQuery | undefined
    private devModelView: DevModelView | undefined
    private devConnectors: EngineConnectorService | undefined
    private environmentConnectors: EngineConnectorService | undefined
    private promoteRecords: PromoteRecordStore | undefined
    private environmentEngine: EnvironmentEngineHost | undefined
    private environmentScopes: Promise<AccessScopeSource> | undefined
    private environmentCypher: EngineCypherQuery | undefined
    private environmentModelView: EnvironmentModelView | undefined
    private environmentExecute: EnvironmentCypherExecute | undefined
    private environmentWriter: EnvironmentDataWriter | undefined
    private dataChanges: DataChangedPush | undefined
    private environmentShares: EnvironmentShareService | undefined
    private environmentAssign: EnvironmentAssignService | undefined
    private securitySetting: Promise<EnvironmentSecuritySetting> | undefined
    private directorySync: Promise<IdpDirectorySyncHost> | undefined
    private deprovisioned: ISubscription | undefined
    private systemPrincipal: Promise<SystemPrincipalScope> | undefined
    private deliverySecurity: Promise<DeliverySecurity> | undefined
    private securityChangeLog: SecurityChangeLog | undefined
    private environmentRules: EnvironmentScopeRules | undefined
    private devExecute: DevCypherExecute | undefined

    public constructor(options: PragmaticServerOptions)
    {
        this.options = options
        this.platform = PlatformSelector.Resolve(options.platform, options.deploymentMode ?? DeploymentMode.Local)
        this.identity = options.identity === undefined ? undefined : new IdentityModule(options.identity, this.platform)
        const builder = LazyCompositionRoot.Builder(HostKinds.Server)
            .Module(new SolutionServicesModule())
            .Module(new LanguageServiceModule())
        this.root = builder.Build()
        this.callerCredentials = new CallerCredentials(options.logger)
        this.connectorsHost = new ConnectorsHost(PragmaticServer.ConnectorsOptions(options, this.callerCredentials))
        this.RegisterAdapterFactories()
        this.RegisterInfrastructure(options.packagesRoot ?? PragmaticServer.DefaultPackagesDir)
    }

    /** The connectors host's options: the adapter-pack provider (if any) wrapped in the caller's credentials (PR12). */
    private static ConnectorsOptions(options: PragmaticServerOptions, credentials: CallerCredentials): ConnectorsHostOptions | undefined
    {
        const packs = options.connectors?.provider ?? PragmaticServer.AdapterPackProvider(options)
        const provider = packs === undefined ? undefined : new CallerCredentialAdapterProvider(packs, credentials)
        if (options.connectorsPolicy === undefined)
        {
            return provider === undefined ? options.connectors : { ...options.connectors, provider }
        }
        const resolver = new PolicyConnectionResolver(options.connectorsPolicy, options.connectors?.connectionResolver)
        return { ...options.connectors, connectionResolver: resolver, provider }
    }

    /** Builds this tenant's adapter-pack provider: its own ConnectorsPolicy gate over the deployment-global pack settings. */
    private static AdapterPackProvider(options: PragmaticServerOptions): IDataSourceAdapterProvider | undefined
    {
        const packs = options.adapterPacks
        if (packs === undefined)
        {
            return undefined
        }
        const limits = packs.resourceLimits
        const eviction = packs.eviction
        return new NpmAdapterPackProvider({
            cacheDir: packs.cacheDir,
            sandboxFactory: packs.sandboxStrategy === SandboxStrategy.Child ? new ChildProcessSandboxFactory() : new WorkerThreadSandboxFactory(),
            sandboxOptions: limits === undefined ? undefined : { resourceLimits: limits },
            allowProviderOverride: options.connectorsPolicy?.AllowProviderOverride ?? false,
            providerAllowlist: options.connectorsPolicy?.ProviderAllowlist ?? [],
            requireSignatures: packs.requireSignatures,
            eviction: eviction === undefined ? undefined : { MaxVersionsPerPack: eviction.maxVersionsPerPack, MaxAgeMs: eviction.maxAgeMs },
            scriptAllowlist: packs.scriptAllowlist,
        })
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
                this.callerCredentials.Bind(composed.pack.SourceTokens, composed.tenant, new UpstreamTokenVault(composed.pack.Secrets))
                this.RegisterAdapterFactories()
            }
            catch (error)
            {
                this.root.Services().dispose()
                throw error
            }
            this.StartDirectorySync()
        }
    }

    /**
     * A Runtime tenant with identity starts its IdP directory sync when it starts serving (Task 10 start rule): the
     * first run and the R27 deprovisioning follow begin at Start, not at the first connection. A failure to build it
     * is logged by error name only (a later `DirectorySync()` retries).
     */
    private StartDirectorySync(): void
    {
        if (this.Purpose() !== TenantPurpose.Runtime || this.options.identity?.directorySyncOnStart === false)
        {
            return
        }
        this.DirectorySync().catch((error: unknown) =>
        {
            (this.options.logger ?? StructuredLogger.ToStdout()).Warn(PragmaticServer.DirectorySyncStartFailedLine + (error instanceof Error ? error.name : PragmaticServer.UnknownErrorName))
        })
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

    /**
     * The environment's security setting (contract C5; EnvironmentSecuritySetting over the tenant config store and the
     * IdP directory store), memoized for this tenant (a failed build is retried) and disposed with the server after the
     * environment scopes. Runtime tenants with identity only: a Development tenant has no setting (PR13).
     */
    public SecuritySetting(): Promise<EnvironmentSecuritySetting>
    {
        if (this.disposing !== undefined)
        {
            return Promise.reject(new Error(PragmaticServer.DisposedMessage))
        }
        this.AssertRuntimePurpose()
        if (this.securitySetting === undefined)
        {
            const built = this.BuildSecuritySetting()
            this.securitySetting = built
            built.catch(() =>
            {
                if (this.securitySetting === built)
                {
                    this.securitySetting = undefined
                }
            })
        }
        return this.securitySetting
    }

    /**
     * What the admin save checks a security setting against and reloads (EnvironmentSecurityAdmin); undefined on a
     * Development tenant, which refuses the setting (PR13). Requires identity.
     */
    public async SecurityAdmin(): Promise<ISecuritySettingAdmin | undefined>
    {
        if (this.Purpose() !== TenantPurpose.Runtime)
        {
            return undefined
        }
        return new EnvironmentSecurityAdmin(await this.SecuritySetting(), this.EnvironmentEngine(), await this.DirectorySync(), this.SecurityChangeLog())
    }

    private async BuildSecuritySetting(): Promise<EnvironmentSecuritySetting>
    {
        const store = await this.TenantConfigStore()
        const pack = await this.Pack()
        return new EnvironmentSecuritySetting(store, pack.IdpDirectory, this.Tenant(), new LoggerSecuritySettingDiagnostics(this.options.logger ?? StructuredLogger.ToStdout()))
    }

    /**
     * The tenant's IdP directory sync host (S4 Task 10): pulls the directory on start, after each `SetSecurityModel` and
     * every {@link IdpDirectorySyncHost.IntervalMs}, invalidating {@link SecuritySetting} after each run. Memoized (a
     * failed build is retried) and disposed with the server before the setting. Runtime tenants with identity only; one
     * `PragmaticServer` holds the tenant lease, so exactly one replica polls.
     */
    public DirectorySync(): Promise<IdpDirectorySyncHost>
    {
        if (this.disposing !== undefined)
        {
            return Promise.reject(new Error(PragmaticServer.DisposedMessage))
        }
        this.AssertRuntimePurpose()
        if (this.identity === undefined)
        {
            return Promise.reject(new Error(PragmaticServer.IdentityNotConfiguredError))
        }
        if (this.directorySync === undefined)
        {
            const built = this.BuildDirectorySync()
            this.directorySync = built
            built.catch(() =>
            {
                if (this.directorySync === built)
                {
                    this.directorySync = undefined
                }
            })
        }
        return this.directorySync
    }

    private async BuildDirectorySync(): Promise<IdpDirectorySyncHost>
    {
        const pack = await this.Pack()
        const setting = await this.SecuritySetting()
        const sync = new IdpDirectorySync(pack.DirectorySource, pack.IdpDirectory, pack.Sessions, pack.Audit)
        const host = new IdpDirectorySyncHost(sync, setting, this.Tenant())
        // R27: a deprovisioned principal's stored upstream tokens, cached source tokens and inner connections go
        this.deprovisioned?.dispose()
        this.deprovisioned = this.callerCredentials.Follow(host.Deprovisioned)
        // one run when the tenant's server starts serving (Start builds this: StartDirectorySync)
        void host.RunNow()
        return host
    }

    public Purpose(): TenantPurpose
    {
        return this.options.purpose ?? TenantPurpose.Development
    }

    public AppsStorage(): IStorage
    {
        if (this.appsStorage === undefined)
        {
            if (this.options.applicationsRoot === undefined)
            {
                throw new Error(PragmaticServer.ApplicationsRootRequiredError)
            }
            this.appsStorage = this.platform.CreateStorage(this.options.applicationsRoot)
        }
        return this.appsStorage
    }

    public PackagesStorage(): IStorage
    {
        return this.platform.CreateStorage(this.options.packagesRoot ?? PragmaticServer.DefaultPackagesDir)
    }

    public GraphsStorage(): IStorage
    {
        return this.platform.CreateStorage(this.options.graphsRoot ?? PragmaticServer.DefaultGraphsDir)
    }

    /**
     * Ingests a deployed application onto this runtime tenant through the environment engine's delivery gate (ruling
     * S4); the caller has already authorized Administer on the tenant.
     */
    public async DeployApplication(params: CypherAppDeployParamsDto): Promise<AppDeployResultDto>
    {
        this.AssertRuntimePurpose()
        this.appIngest ??= new AppIngestService(this.PackagesStorage(), this.AppsStorage(), this.EnvironmentEngine(), StructuredLogger.ToStdout())
        return this.appIngest.Ingest(params)
    }

    /** The container-owned graph catalog; development tenants only. */
    public GraphService(): IDevGraphService
    {
        this.AssertDevelopmentPurpose()
        this.devGraphService ??= new DevGraphService(new DevGraphStore(this.GraphsStorage()), new GraphPackageIngest(this.PackagesStorage()), new GraphPackageReader(this.PackagesStorage()))
        return this.devGraphService
    }

    /**
     * Promotes a package set (ruling S4): stores the packages immutably, then through the environment engine's delivery
     * gate composes every live app plus this set (an EnvironmentCatalogError is InvalidParams with its message, and the
     * promote record is left as it was), persists the promote record (it replaces the previous set) and upgrades the
     * environment engine (a failure there is InternalError; the record stays and the engine retries on next use).
     * Returns the record. Runtime tenants only.
     */
    public async LoadEnvironmentGraph(params: GraphLoadParamsDto): Promise<GraphLoadedDto>
    {
        this.AssertRuntimePurpose()
        await new GraphPackageIngest(this.PackagesStorage()).Store(params.packages)
        const record: GraphLoadedDto = { name: params.graphName, packages: params.packages.map(p => ({ id: p.id, version: p.version })), promotedAt: new Date().toISOString() }
        const change = { Channel: DeliveryChannel.Promote, Name: record.name, Packages: record.packages.map(ref => ({ model: ref.id, version: ref.version })) }
        try
        {
            // the promote's security changes are in the change log; `graph/load` answers the record only
            return (await this.EnvironmentEngine().Deliver(change, async () =>
            {
                await this.PromoteRecords().Save(record)
                return record
            })).Result
        }
        catch (error)
        {
            if (error instanceof EnvironmentCatalogError)
            {
                throw new ResponseError(ErrorCodes.InvalidParams, InvalidParamsPrefix.Text + error.message)
            }
            if (error instanceof EnvironmentUpgradeFailedError)
            {
                throw new ResponseError(ErrorCodes.InternalError, EnvironmentUpgradeFailedError.PromoteReason)
            }
            throw error
        }
    }

    /** The promote record (`graphs/loaded-graph.json`, ruling S3): survives a restart; null when nothing was ever promoted. */
    public async LoadedGraph(): Promise<GraphLoadedDto | null>
    {
        return this.PromoteRecords().Read()
    }

    /**
     * The runtime environment's ONE graph engine (rulings S2-S4), over every live app plus the promote record, opened
     * on first use (LMDB at `<graphsRoot>/environment-engine` unless `environmentEngineStorage` says otherwise; Q7: the
     * graphs root must be on storage the next lease holder reaches). Memoized; disposed with the server before the
     * connectors host (its connectors borrow that host's adapters). Runtime tenants only.
     */
    public EnvironmentEngine(): EnvironmentEngineHost
    {
        if (this.disposing !== undefined)
        {
            throw new Error(PragmaticServer.DisposedMessage)
        }
        this.AssertRuntimePurpose()
        if (this.environmentEngine === undefined)
        {
            const storage = { Kind: this.options.environmentEngineStorage ?? StorageKind.Lmdb, Path: join(this.options.graphsRoot ?? PragmaticServer.DefaultGraphsDir, EnvironmentEngineHost.StoreDir) }
            // with identity every delivery applies its security diff (S4 Task 13); without, deliveries change no setting
            const security = this.identity === undefined ? undefined : (): Promise<DeliverySecurity> => this.DeliverySecurity()
            this.environmentEngine = new EnvironmentEngineHost(new EnvironmentDeliveries(this.Applications(), this.PromoteRecords()), this.PackagesStorage(), this.root.Services(), storage,
                new LoggerEnvironmentDiagnostics(this.options.logger ?? new NullLogger()), {}, new TimeoutUpgradeTimer(), security)
        }
        return this.environmentEngine
    }

    /**
     * The runtime environment's access scopes over {@link PragmaticServer.EnvironmentEngine} (AccessScopeSource under
     * EnvironmentScopeRules, ruling S5 as amended by A3, placement S6): with identity, the tier-1 scope of the
     * environment security setting (connector-bound concepts outside it), read-only bindings and seeded nodes; without
     * identity Default Allow with the read-only guards. Built on first use (a failed build is retried), disposed with the server
     * before the engine host. Runtime tenants only.
     */
    public EnvironmentScopes(): Promise<AccessScopeSource>
    {
        if (this.disposing !== undefined)
        {
            return Promise.reject(new Error(PragmaticServer.DisposedMessage))
        }
        this.AssertRuntimePurpose()
        if (this.environmentScopes === undefined)
        {
            const built = this.BuildEnvironmentScopes()
            this.environmentScopes = built
            built.catch(() =>
            {
                if (this.environmentScopes === built)
                {
                    this.environmentScopes = undefined
                }
            })
        }
        return this.environmentScopes
    }

    /**
     * The runtime `cypher/query` and `cypher/models` (rulings S1, S11, S12): the shared EngineCypherQuery over
     * {@link PragmaticServer.EnvironmentEngine} under each caller's {@link PragmaticServer.EnvironmentScopes}; `modelId`
     * is a delivered package id. Memoized; runtime tenants only.
     */
    public EnvironmentCypher(): EngineCypherQuery
    {
        this.AssertRuntimePurpose()
        this.environmentCypher ??= new EngineCypherQuery(this.EnvironmentEngine(), () => this.EnvironmentScopes())
        return this.environmentCypher
    }

    /**
     * The runtime `model/view` and `model/resources` (ruling S15): projected from {@link PragmaticServer.EnvironmentEngine}
     * under each caller's {@link PragmaticServer.EnvironmentScopes} AND the S12 model filter; `memberId` is a delivered
     * package id; `model/resources` is `[]`. Memoized; runtime tenants only.
     */
    public EnvironmentModelView(): EnvironmentModelView
    {
        this.AssertRuntimePurpose()
        this.environmentModelView ??= new EnvironmentModelView(this.EnvironmentEngine(), () => this.EnvironmentScopes())
        return this.environmentModelView
    }

    /** The runtime `cypher/execute` (ruling S13) on the environment engine, under each caller's environment scope. Memoized; runtime tenants only. */
    public EnvironmentExecute(): EnvironmentCypherExecute
    {
        this.AssertRuntimePurpose()
        this.environmentExecute ??= new EnvironmentCypherExecute(this.EnvironmentEngine(), () => this.EnvironmentScopes(), new LoggerExecuteDiagnostics(this.options.logger ?? new NullLogger()))
        return this.environmentExecute
    }

    /**
     * The runtime `connector/*` endpoints (ruling S14) on the environment engine, under each caller's environment scope:
     * the shared EngineConnectorService over the process-wide adapter catalog. Memoized; runtime tenants only.
     */
    public EnvironmentConnectors(): EngineConnectorService
    {
        this.AssertRuntimePurpose()
        this.environmentConnectors ??= new EngineConnectorService(this.EnvironmentEngine(), () => this.EnvironmentScopes(), this.AdapterCatalog(), this.root.Services())
        return this.environmentConnectors
    }

    /** The runtime `data/write` (ruling S10) on the environment engine, under each caller's environment scope. Memoized; runtime tenants only. */
    public EnvironmentWriter(): EnvironmentDataWriter
    {
        this.AssertRuntimePurpose()
        this.environmentWriter ??= new EnvironmentDataWriter(this.EnvironmentEngine(), () => this.EnvironmentScopes(), new RuntimeWritePayloadValidator())
        return this.environmentWriter
    }

    /**
     * The runtime `data/changed` push (ruling S16) following {@link PragmaticServer.EnvironmentEngine}'s commits; runtime
     * connections subscribe under their {@link PragmaticServer.EnvironmentScopes}. Memoized, disposed with the server
     * before the engine host; runtime tenants only (dev tenants keep `solution/graphChanged`).
     */
    public DataChanges(): DataChangedPush
    {
        if (this.disposing !== undefined)
        {
            throw new Error(PragmaticServer.DisposedMessage)
        }
        this.AssertRuntimePurpose()
        this.dataChanges ??= new DataChangedPush(this.EnvironmentEngine(), undefined, new LoggerDataChangedDiagnostics(this.options.logger ?? new NullLogger()), this.BackgroundConnector())
        return this.dataChanges
    }

    /**
     * The scope of work no user started (connector population, scheduled flows, agents, identity resolution, deploy
     * backfill): the environment's system principal's (SystemPrincipalScope), memoized per scope-source generation (a
     * security reload or an engine upgrade yields a fresh scope with the same rights). Runtime tenants with identity only.
     */
    public async SystemScope(): Promise<IGraphScope>
    {
        return (await this.SystemPrincipal()).Scope()
    }

    /** The system principal's scope and assign scope (SystemPrincipalScope), memoized; disposed before the scope source. */
    public SystemPrincipal(): Promise<SystemPrincipalScope>
    {
        if (this.disposing !== undefined)
        {
            return Promise.reject(new Error(PragmaticServer.DisposedMessage))
        }
        this.AssertRuntimePurpose()
        if (this.systemPrincipal === undefined)
        {
            const built = this.BuildSystemPrincipal()
            this.systemPrincipal = built
            built.catch(() =>
            {
                if (this.systemPrincipal === built)
                {
                    this.systemPrincipal = undefined
                }
            })
        }
        return this.systemPrincipal
    }

    /**
     * The environment's security change log (`graphs/security-changes.json`, S4 Task 13): the security changes of the
     * deploys and promotes that changed any, newest first. Memoized; runtime tenants only.
     */
    public SecurityChangeLog(): SecurityChangeLog
    {
        this.AssertRuntimePurpose()
        this.securityChangeLog ??= new SecurityChangeLog(this.GraphsStorage(), new LoggerSecurityChangeLogDiagnostics(this.options.logger ?? StructuredLogger.ToStdout()))
        return this.securityChangeLog
    }

    /**
     * What a delivery does to the environment's security (DeliverySecurity over {@link SecuritySetting}, {@link
     * SecurityChangeLog} and {@link SystemPrincipal}), memoized (a failed build is retried). Runtime tenants with identity.
     */
    private DeliverySecurity(): Promise<DeliverySecurity>
    {
        if (this.deliverySecurity === undefined)
        {
            const built = this.BuildDeliverySecurity()
            this.deliverySecurity = built
            built.catch(() =>
            {
                if (this.deliverySecurity === built)
                {
                    this.deliverySecurity = undefined
                }
            })
        }
        return this.deliverySecurity
    }

    private async BuildDeliverySecurity(): Promise<DeliverySecurity>
    {
        return new DeliverySecurity(await this.SecuritySetting(), this.SecurityChangeLog(), () => this.SystemPrincipal(), new PendingBackfillStore(this.GraphsStorage()))
    }

    /** Revokes a principal's per-user source credentials (R27): the auth endpoint calls it on sign-out. */
    public CallerCredentials(): ICallerCredentialRevoker
    {
        return this.callerCredentials
    }

    private async BuildSystemPrincipal(): Promise<SystemPrincipalScope>
    {
        const tenant = this.Tenant()
        const scopes = await this.EnvironmentScopes()
        return new SystemPrincipalScope(scopes, this.environmentRules!, tenant)
    }

    /** The context background work's own engine reads run under: the system principal's; Anonymous without identity. */
    private BackgroundConnector(): ConnectorContext
    {
        return this.identity === undefined ? ConnectorContext.Anonymous : CallerConnectorContext.System(this.Tenant())
    }

    private async BuildEnvironmentScopes(): Promise<AccessScopeSource>
    {
        const host = this.EnvironmentEngine()
        const setting = this.identity === undefined ? undefined : await this.SecuritySetting()
        const rules = new EnvironmentScopeRules(host, setting)
        this.environmentRules = rules
        return new AccessScopeSource(host, rules, new LoggerScopeDiagnostics(this.options.logger ?? new NullLogger()))
    }

    /** The tier-1 decisions of the environment's scope rules, for the share and assign services. */
    private async EnvironmentTier1(): Promise<IEnvironmentTier1>
    {
        await this.EnvironmentScopes()
        return this.environmentRules!
    }

    /** The environment's promote record (`graphs/loaded-graph.json`, ruling S3). */
    private PromoteRecords(): PromoteRecordStore
    {
        this.promoteRecords ??= new PromoteRecordStore(this.GraphsStorage())
        return this.promoteRecords
    }

    /** Throws unless this is a Development tenant: the graph catalog exists only there. */
    private AssertDevelopmentPurpose(): void
    {
        if (this.Purpose() !== TenantPurpose.Development)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, PragmaticServer.NotDevelopmentMessage)
        }
    }

    /** Throws unless this is a Runtime tenant: deploy and the applications registry exist only there. */
    private AssertRuntimePurpose(): void
    {
        if (this.Purpose() !== TenantPurpose.Runtime)
        {
            throw new Error(PragmaticServer.ApplicationsRuntimeOnlyError)
        }
    }

    public Applications(): PragmaticAppsRegistry
    {
        this.AssertRuntimePurpose()
        this.appsRegistry ??= new PragmaticAppsRegistry(this.AppsStorage())
        return this.appsRegistry
    }

    /**
     * `data/write` (ruling S10): one engine transaction per batch on the environment engine under the caller's
     * environment scope ({@link PragmaticServer.EnvironmentWriter}). The app name is the bound `application/open`
     * app; it selects nothing here (S7).
     */
    public WriteForPragmaticApp(context: AccessContext, _name: string, operations: readonly AppWriteOpDto[]): Promise<AppWriteResultDto>
    {
        return this.EnvironmentWriter().Apply(context, operations)
    }

    /**
     * `data/share` (ruling S8): a `todl.system.ShareGrant` written on the environment engine under the caller's scope
     * ({@link PragmaticServer.EnvironmentShares}); the app name selects nothing (S7). Requires identity.
     */
    public async ShareForPragmaticApp(context: AccessContext, _name: string, params: ShareParams): Promise<ShareResultDto>
    {
        return await this.EnvironmentShares().Share(context, params)
    }

    /** `data/unshare` (ruling S8): deletes the grant on the environment engine; the app name selects nothing (S7). Requires identity. */
    public async UnshareForPragmaticApp(context: AccessContext, _name: string, params: UnshareParams): Promise<UnshareResultDto>
    {
        return await this.EnvironmentShares().Unshare(context, params)
    }

    /** `data/listShares` (ruling S8): the grants linking the record on the environment engine; the app name selects nothing (S7). Requires identity. */
    public async ListSharesForPragmaticApp(context: AccessContext, _name: string, params: ListSharesParams): Promise<ListSharesResultDto>
    {
        return await this.EnvironmentShares().List(context, params)
    }

    /** `data/assign` (ruling S9): the record's ownership members written on the environment engine ({@link PragmaticServer.EnvironmentAssign}). Requires identity. */
    public async AssignForPragmaticApp(context: AccessContext, _name: string, params: AssignParams): Promise<AssignResultDto>
    {
        return await this.EnvironmentAssign().Assign(context, params)
    }

    /**
     * The runtime share service (ruling S8) on the environment engine under each caller's environment scope, with the
     * caller's tier-1 grants (EnvironmentScopeRules). Memoized; runtime tenants with identity only (else the error is unchanged:
     * "record sharing requires an identity subsystem").
     */
    public EnvironmentShares(): EnvironmentShareService
    {
        this.AssertRuntimePurpose()
        if (this.identity === undefined)
        {
            throw new Error(PragmaticServer.SharingRequiresIdentityError)
        }
        this.environmentShares ??= new EnvironmentShareService(this.EnvironmentEngine(), () => this.EnvironmentScopes(), () => this.EnvironmentTier1())
        return this.environmentShares
    }

    /** The runtime assign service (ruling S9), as {@link PragmaticServer.EnvironmentShares}; without identity "record assignment requires an identity subsystem". */
    public EnvironmentAssign(): EnvironmentAssignService
    {
        this.AssertRuntimePurpose()
        if (this.identity === undefined)
        {
            throw new Error(PragmaticServer.AssignRequiresIdentityError)
        }
        this.environmentAssign ??= new EnvironmentAssignService(this.EnvironmentEngine(), () => this.EnvironmentScopes(), () => this.EnvironmentTier1())
        return this.environmentAssign
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

    /**
     * The dev tenant's embedded graph engine over the active solution's SAVED sources, opened on first use and
     * upgraded as saves recompile. Memoized: assumes LanguageService() resolves to a stable singleton for this
     * server's lifetime.
     */
    public DevEngine(): IDevGraphEngine
    {
        if (this.disposing !== undefined)
        {
            throw new Error(PragmaticServer.DisposedMessage)
        }
        if (this.devEngine === undefined)
        {
            const logger = this.options.logger ?? new NullLogger()
            // external plans borrow their adapters from the process-wide DataSourceAdapterCatalog (ruling S18)
            this.devEngine = new DevGraphEngineHost(async () => (await this.Manager()).ActiveSolution, () => this.SolutionLanguageService(), undefined,
                new LoggerDevEngineDiagnostics(logger), new LoggerDevWriteDiagnostics(logger), undefined, undefined, () => this.root.Services())
        }
        return this.devEngine
    }

    /**
     * The dev tenant's access scopes over {@link PragmaticServer.DevEngine}: unrestricted for every principal the
     * PolicyGate admits (AccessScopeSource under DevScopeRules, PR13), diagnostics on the configured logger. Built on first use, disposed
     * with the server.
     */
    public DevScopes(): Promise<AccessScopeSource>
    {
        if (this.disposing !== undefined)
        {
            return Promise.reject(new Error(PragmaticServer.DisposedMessage))
        }
        if (this.devScopes === undefined)
        {
            const built = this.BuildDevScopes()
            this.devScopes = built
            // a failed build is retried by the next call
            built.catch(() =>
            {
                if (this.devScopes === built)
                {
                    this.devScopes = undefined
                }
            })
        }
        return this.devScopes
    }

    /** The dev `cypher/query` and `cypher/models` on the engine, under each caller's dev scope. */
    public DevCypher(): EngineCypherQuery
    {
        this.devCypher ??= new EngineCypherQuery(this.DevEngine(), () => this.DevScopes())
        return this.devCypher
    }

    /**
     * The dev `connector/*` endpoints (ruling S14) on the dev engine, under each caller's dev scope: the same
     * EngineConnectorService the runtime uses (S1). Memoized.
     */
    public DevConnectors(): EngineConnectorService
    {
        this.devConnectors ??= new EngineConnectorService(this.DevEngine(), () => this.DevScopes(), this.AdapterCatalog(), this.root.Services())
        return this.devConnectors
    }

    /**
     * The process-wide adapter catalog every external connector borrows its adapters from (ruling S18); every factory
     * registered on it is wrapped in the caller's credentials (PR12).
     */
    public AdapterCatalog(): DataSourceAdapterCatalog
    {
        return this.root.Services().getRequired(DataSourceAdapterCatalog.ServiceKey)
    }

    /**
     * The dev model/view and model/resources visibility: structure from the language service, instance visibility
     * and masking from each caller's dev scope on the engine (memoized; disposed with the server).
     */
    public DevModelView(): DevModelView
    {
        this.devModelView ??= new DevModelView(this.DevEngine(), () => this.DevScopes(), async () => (await this.Manager()).ActiveSolution, () => this.LanguageService(), new LoggerDevModelViewDiagnostics(this.options.logger ?? new NullLogger()))
        return this.devModelView
    }

    private async BuildDevScopes(): Promise<AccessScopeSource>
    {
        const engine = this.DevEngine()
        return new AccessScopeSource(engine, new DevScopeRules(() => this.ActiveSolutionName()), new LoggerScopeDiagnostics(this.options.logger ?? new NullLogger()))
    }

    private async ActiveSolutionName(): Promise<string | undefined>
    {
        return (await this.Manager()).ActiveSolution?.Name
    }

    /** The language service as its concrete type (the key resolves it typed), for slices ILanguageService omits. */
    private async SolutionLanguageService(): Promise<SolutionLanguageService>
    {
        return this.root.Resolve(SolutionLanguageService.Key)
    }

    public async OpenSolution(location: string): Promise<void>
    {
        const manager = await this.Manager()
        await manager.OpenSolution(location)
    }

    /**
     * The dev `cypher/execute` on the engine, under each caller's dev scope (memoized, one per tenant): CREATEs placed in
     * `modelId`, which must be one of `cypher/models` (else InvalidParams); serialized per tenant under the write lease.
     */
    public DevExecute(): DevCypherExecute
    {
        this.devExecute ??= new DevCypherExecute(this.DevEngine(), () => this.DevScopes(), async () => (await this.LanguageService()).GraphRevision, this.options.writeLock ?? new InProcessWriteLock(), new LoggerDevExecuteDiagnostics(this.options.logger ?? new NullLogger()))
        return this.devExecute
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

    public InvalidateAdapterPack(name: string): Promise<void>
    {
        return this.connectorsHost.InvalidateProvider(name)
    }

    public AllowAdapterPackScripts(name: string): Promise<void>
    {
        return this.connectorsHost.AllowPackScripts(name)
    }

    public DenyAdapterPackScripts(name: string): Promise<void>
    {
        return this.connectorsHost.DenyPackScripts(name)
    }

    public ListAdapterPackScripts(): Promise<readonly string[]>
    {
        return this.connectorsHost.ListPackScriptAllowlist()
    }

    private async DoDispose(): Promise<void>
    {
        try
        {
            this.dataChanges?.dispose()
            // the system principal's scope follows the scope source: it unsubscribes first
            const systemPrincipal = await this.systemPrincipal?.catch(() => undefined)
            systemPrincipal?.dispose()
            // the scope source unsubscribes from the engine host and the security setting before either goes
            const environmentScopes = await this.environmentScopes?.catch(() => undefined)
            environmentScopes?.dispose()
            // the directory sync host polls the setting: stop it before the setting goes
            // awaited first: a build still running would otherwise subscribe after the follow below is disposed
            const directorySync = await this.directorySync?.catch(() => undefined)
            this.deprovisioned?.dispose()
            directorySync?.dispose()
            const setting = await this.securitySetting?.catch(() => undefined)
            setting?.dispose()
            // the environment engine's connectors borrow adapters from the connectors host's catalog: it closes first
            await this.environmentEngine?.dispose()
        }
        finally
        {
            try
            {
                await this.connectorsHost.Dispose()
            }
            finally
            {
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
                    try
                    {
                        // the model view and the scope source unsubscribe from the engine host before the engine goes
                        this.devModelView?.dispose()
                        const scopes = await this.devScopes?.catch(() => undefined)
                        scopes?.dispose()
                        await this.devEngine?.dispose()
                    }
                    finally
                    {
                        await this.DrainLanguageService()
                        this.root.Services().dispose()
                    }
                }
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

    /**
     * Registers the built-in adapter factories and `adapterFactories` (a later one replaces an earlier one of its kind),
     * each wrapped in the caller's credentials (PR12). Run at construction (unbound: caller's-identity connections are
     * refused) and again once identity is bound (Start).
     */
    private RegisterAdapterFactories(): void
    {
        const connectors = this.options.connectors
        const factories: IDataSourceAdapterFactory[] = [
            new SqlAdapterFactory(connectors?.buildPool),
            new RestAdapterFactory(connectors?.restClient),
            new CypherAdapterFactory(),
            new DocumentAdapterFactory(),
            ...(this.options.adapterFactories ?? []),
        ]
        for (const factory of factories)
        {
            this.connectorsHost.Catalog.Register(this.callerCredentials.Wrap(factory))
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
