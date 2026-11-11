import { join } from 'node:path'
import { StorageKind } from '@pragmatic-tech-ai/graph'
import { LazyCompositionRoot, HostKinds, ModuleStateKind } from '@pragmatic-tech-ai/todl-runtime'
import { TenantPurpose } from './tenancy/tenant-purpose.js'
import type { ModuleStateProperty } from '@pragmatic-tech-ai/todl-runtime'
import { SolutionManagerService, StoragePackageSource, StoragePackageStore, PackageStoreKey, ConnectorPrefetch, ConnectorRuntimeGraphQuery, DataSourceAdapterCatalog } from '@pragmatic-tech-ai/todl'
import type { ModelConnectorPlan, IDataSourceAdapterProvider, IDataSourceAdapterFactory } from '@pragmatic-tech-ai/todl'
import type { Domain } from '@pragmatic-tech-ai/todl/domain'
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
import { ConnectorsHost, NpmAdapterPackProvider, WorkerThreadSandboxFactory, ChildProcessSandboxFactory } from '@pragmatic-tech-ai/todl-connectors-host'
import { SandboxStrategy } from './config/server-config.js'
import type { AdapterPacksConfig } from './config/server-config.js'
import type { ConnectorsHostOptions } from '@pragmatic-tech-ai/todl-connectors-host'
import { BuiltinAdapterFactory } from './host/connectors/builtin-adapter-factory.js'
import { BuiltinBindings } from './host/connectors/builtin-bindings.js'
import { BuiltinStoreEngine } from './host/connectors/builtin-store-engine.js'
import { SolutionConnectorPlanner } from './connectors/solution-connector-planner.js'
import { ConnectorRuntime } from './connectors/connector-runtime.js'
import { PolicyConnectionResolver } from './host/policy-connection-resolver.js'
import type { ConnectorsPolicy } from './host/connector-policy.js'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { TenantReadAuthorization, AllowAllReadFilterSource, AllowAllFieldReadMaskSource } from './host/cypher/read-filter-source.js'
import { AllowAllWriteAuthorizerSource } from './host/cypher/read-filter-source.js'
import type { IReadFilterSource, IWriteAuthorizerSource, IFieldReadMaskSource, ISecurityModelReload } from './host/cypher/read-filter-source.js'
import { ConnectorReadAuthorizations } from './host/connector-read-authorization.js'
import type { IConnectorReadAuthorization } from './host/connector-read-authorization.js'
import { ConnectorHydrateWriter } from './host/connector-hydrate-writer.js'
import type { IHydrateAuthorization } from './host/connector-hydrate-writer.js'
import type { IWriteTargetSource } from './host/write-target-source.js'
import { AllowAllWriteInstanceGate } from './host/cypher/write-instance-gate.js'
import type { IWriteInstanceGate } from './host/cypher/write-instance-gate.js'
import { FilteredReadWriteTargetSource } from './host/filtered-read-write-target-source.js'
import { RuntimeAppWriter } from './host/runtime-app-writer.js'
import { RuntimeWritePayloadValidator } from './host/runtime-write-payload-validator.js'
import type { AppWriteOpDto, AppWriteResultDto, ShareParams, ShareResultDto, UnshareParams, UnshareResultDto, ListSharesParams, ListSharesResultDto, AssignParams, AssignResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ResponseError, ErrorCodes, AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ShareService } from './host/sharing/share-service.js'
import { AssignService } from './host/sharing/assign-service.js'
import { FilteredGraphQuery } from './host/cypher/filtered-graph-query.js'
import { InProcessWriteLock, type IWriteLock } from './host/cypher/write-lock.js'
import { GraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { DeliveryChannel, EnvironmentCatalogError } from '@pragmatic-tech-ai/todl/engine'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import type { CypherAppDeployParamsDto, AppDeployResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DevCypherExecute, LoggerDevExecuteDiagnostics } from './host/engine/dev-cypher-execute.js'
import { LoggerExecuteDiagnostics } from './host/engine/graph-cypher-execute.js'
import { PragmaticAppsRegistry } from './host/apps/pragmatic-apps-registry.js'
import { NullLogger, StructuredLogger } from './observability/logger.js'
import type { ILogger } from './observability/logger.js'
import { AppIngestService } from './host/apps/app-ingest-service.js'
import { RuntimeAppGraph } from './host/cypher/runtime-app-graph.js'
import { AppConnectorPlan } from './host/cypher/app-connector-plan.js'
import type { PragmaticAppManifest } from './host/apps/pragmatic-app-manifest.js'
import { ShareStore } from './host/sharing/share-store.js'
import { ShareGrantIndex } from './host/sharing/share-grant-index.js'
import { ShareWideningInstanceFilter } from './host/sharing/share-widening-instance-filter.js'
import { ConceptIdFields } from './host/sharing/concept-id-fields.js'
import { ShareWideningWriteInstanceGate } from './host/sharing/share-widening-write-instance-gate.js'
import { ShareWideningWriteAuthorizer } from './host/sharing/share-widening-write-authorizer.js'
import { DevGraphStore } from './host/graphs/dev-graph-store.js'
import { GraphPackageIngest } from './host/graphs/graph-package-ingest.js'
import { GraphPackageReader } from './host/graphs/graph-package-reader.js'
import { DevGraphService, type IDevGraphService } from './host/graphs/dev-graph-service.js'
import { DevGraphEngineHost, LoggerDevEngineDiagnostics } from './host/engine/dev-graph-engine-host.js'
import { LoggerDevWriteDiagnostics } from './host/engine/server-model-workspace.js'
import type { IDevGraphEngine } from './host/engine/dev-graph-engine-host.js'
import { AccessScopeSource, LoggerScopeDiagnostics } from './host/engine/access-scope-source.js'
import { DevScopeRules } from './host/engine/dev-scope-rules.js'
import { EngineCypherQuery } from './host/engine/engine-cypher-query.js'
import { DevModelView, LoggerDevModelViewDiagnostics } from './host/engine/dev-model-view.js'
import { PromoteRecordStore } from './host/environment/promote-record-store.js'
import { EnvironmentDeliveries } from './host/environment/environment-deliveries.js'
import { EnvironmentEngineHost, EnvironmentUpgradeFailedError, LoggerEnvironmentDiagnostics } from './host/environment/environment-engine-host.js'
import type { IEnvironmentGraphHost } from './host/environment/environment-engine-host.js'
import { EnvironmentCypherExecute } from './host/environment/environment-cypher-execute.js'
import { EnvironmentScopeRules } from './host/environment/environment-scope-rules.js'
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
}

export interface PragmaticServerOptions
{
    purpose?: TenantPurpose
    applicationsRoot?: string
    packagesRoot?: string
    graphsRoot?: string
    identity?: PragmaticServerIdentityOptions
    deploymentMode?: DeploymentMode
    builtinStoreEngine?: BuiltinStoreEngine
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

/** The node labels a Cypher query references; wildcard when any node pattern is unlabeled; parseFailed when the text is not valid Cypher (nothing is prefetched). */
export type ReferencedLabelSet = { labels: readonly string[]; wildcard: boolean; parseFailed: boolean }

type AppBase = { domain: Domain; plan: ModelConnectorPlan; nativeBase: IGraphQuery; defaultConcepts: ReadonlySet<string> }

/** Headless single-tenant in-process host: composes the engine over the lazy root and opens a solution. */
export class PragmaticServer implements IEnvironmentGraphHost
{
    private static readonly DefaultPackagesDir = 'packages'
    private static readonly DefaultGraphsDir = 'graphs'
    private static readonly AppGraphKeySeparator = '@'
    private static readonly BuiltinConnectorPrefix = '__builtin__@'
    private static readonly AppDataDir = 'data'
    private static readonly ApplicationsRootRequiredError = 'applicationsRoot is required for a runtime tenant'
    private static readonly ErrorSeparator = '; '
    private static readonly NamespaceSeparator = '.'
    private static readonly NoLabels: ReferencedLabelSet = { labels: [], wildcard: false, parseFailed: false }

    private static readonly SharingRequiresIdentityError = 'record sharing requires an identity subsystem'
    private static readonly AssignRequiresIdentityError = 'record assignment requires an identity subsystem'
    private static readonly SharingRequiresStoreError = 'record sharing requires the built-in store'
    private static readonly NotStartedError = 'server not started'
    private static readonly ApplicationsRuntimeOnlyError = 'applications are a runtime-tenant feature'
    private static readonly IdentityNotConfiguredError = 'identity not configured'
    private static readonly NoActiveSolutionForConnectors = 'No active solution: open a solution before accessing connectors'
    private static readonly NoMemberStorageForConnectors = 'Active solution has no member storage to read a model view from'
    private static readonly NoModelViewForConnectors = 'Active solution produced no model view'

    private static readonly NotDevelopmentMessage = 'operation requires a development tenant'
    private static readonly DisposedMessage = 'The server has been disposed'

    private readonly root: LazyCompositionRoot
    private readonly options: PragmaticServerOptions
    private readonly platform: PlatformServices
    private readonly identity: IdentityModule | undefined
    private readonly connectorsHost: ConnectorsHost
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
    private promoteRecords: PromoteRecordStore | undefined
    private environmentEngine: EnvironmentEngineHost | undefined
    private environmentScopes: Promise<AccessScopeSource> | undefined
    private environmentCypher: EngineCypherQuery | undefined
    private environmentExecute: EnvironmentCypherExecute | undefined
    private readonly appGraphs = new Map<string, Promise<AppBase>>()
    private readonly shareStores = new Map<string, ShareStore>()
    private readAuth: Promise<TenantReadAuthorization> | undefined
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
        this.connectorsHost = new ConnectorsHost(PragmaticServer.ConnectorsOptions(options))
        this.connectorsHost.Catalog.Register(new BuiltinAdapterFactory((dataRoot, engine) => this.platform.CreateAppDataStore(dataRoot, engine)))
        for (const factory of options.adapterFactories ?? [])
        {
            this.connectorsHost.Catalog.Register(factory)
        }
        this.RegisterInfrastructure(options.packagesRoot ?? PragmaticServer.DefaultPackagesDir)
    }

    private BuiltinEngine(): BuiltinStoreEngine
    {
        return this.options.builtinStoreEngine ?? (this.options.deploymentMode === DeploymentMode.Cloud ? BuiltinStoreEngine.Sqlite : BuiltinStoreEngine.Document)
    }

    private static ConnectorsOptions(options: PragmaticServerOptions): ConnectorsHostOptions | undefined
    {
        const provider = options.connectors?.provider ?? PragmaticServer.AdapterPackProvider(options)
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

    /** The per-request field-read mask source: allow-all without identity, else the tenant's field security. */
    public async FieldReadMaskSource(): Promise<IFieldReadMaskSource>
    {
        if (this.identity === undefined)
        {
            return AllowAllFieldReadMaskSource.Instance
        }
        return this.ReadAuthorization()
    }

    /** The live authorizer-reload seam: an admin SecurityModel change invalidates the cached per-tenant evaluator so the next request re-reads it. Requires identity. */
    public SecurityModelReload(): Promise<ISecurityModelReload>
    {
        return this.ReadAuthorization()
    }

    /** Per-request connector read authorization: allow-all without identity, else the tenant's access-depth filter + field mask. */
    public async ConnectorReadAuthorizationFor(context: AccessContext): Promise<IConnectorReadAuthorization>
    {
        if (this.identity === undefined)
        {
            return ConnectorReadAuthorizations.AllowAll()
        }
        return ConnectorReadAuthorizations.From(await this.ReadAuthorization(), context)
    }

    /** Per-request connector write authorization over the KEYED write target: allow-all without identity, else the tenant's
     *  depth authorizer plus the depth gate (ownership is decided by the depth evaluator alone, mirroring the connector
     *  read filter). */
    public async ConnectorWriteAuthorizationFor(context: AccessContext, target: IWriteTargetSource): Promise<IHydrateAuthorization>
    {
        if (this.identity === undefined)
        {
            return ConnectorHydrateWriter.AllowAll()
        }
        const auth = await this.ReadAuthorization()
        return { authorizer: await auth.WriteAuthorizerFor(context), gate: await auth.WriteInstanceGateFor(context, target) }
    }

    /** The per-request access-depth read filter source: allow-all without identity, else the tenant security model's depth filter. */
    public async DepthFilterSource(): Promise<IReadFilterSource>
    {
        if (this.identity === undefined)
        {
            return AllowAllReadFilterSource.Instance
        }
        return this.ReadAuthorization()
    }

    private async WriteAuthorizerSource(): Promise<IWriteAuthorizerSource>
    {
        if (this.identity === undefined)
        {
            return AllowAllWriteAuthorizerSource.Instance
        }
        return this.ReadAuthorization()
    }

    private async WriteInstanceGate(context: AccessContext, name: string): Promise<IWriteInstanceGate>
    {
        if (this.identity === undefined)
        {
            return AllowAllWriteInstanceGate.Instance
        }
        const target = new FilteredReadWriteTargetSource(this, context, name)
        const auth = await this.ReadAuthorization()
        const gate = await auth.WriteInstanceGateFor(context, target)
        const shareIndex = await this.ShareIndexFor(context, name)
        if (shareIndex.IsEmpty())
        {
            return gate
        }
        return new ShareWideningWriteInstanceGate(gate, shareIndex, ConceptIdFields.From((await this.BaseGraphFor(name)).plan))
    }

    private ReadAuthorization(): Promise<TenantReadAuthorization>
    {
        if (this.readAuth === undefined)
        {
            const built = this.BuildReadAuth()
            this.readAuth = built
            // Evict a failed build so a later call retries (concurrent callers still share the in-flight promise).
            built.catch(() =>
            {
                if (this.readAuth === built)
                {
                    this.readAuth = undefined
                }
            })
        }
        return this.readAuth
    }

    private async BuildReadAuth(): Promise<TenantReadAuthorization>
    {
        return new TenantReadAuthorization(await this.TenantConfigStore())
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
            return await this.EnvironmentEngine().Deliver(change, async () =>
            {
                await this.PromoteRecords().Save(record)
                return record
            })
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
            this.environmentEngine = new EnvironmentEngineHost(new EnvironmentDeliveries(this.Applications(), this.PromoteRecords()), this.PackagesStorage(), this.root.Services(), storage,
                new LoggerEnvironmentDiagnostics(this.options.logger ?? new NullLogger()))
        }
        return this.environmentEngine
    }

    /**
     * The runtime environment's access scopes over {@link PragmaticServer.EnvironmentEngine} (AccessScopeSource under
     * EnvironmentScopeRules, ruling S5 as amended by A3, placement S6): with identity, the tenant security model's depth
     * (connector-bound concepts outside it), share widening, read-only bindings and seeded nodes; without identity
     * Default Allow with the read-only guards. Built on first use (a failed build is retried), disposed with the server
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

    /** The runtime `cypher/execute` (ruling S13) on the environment engine, under each caller's environment scope. Memoized; runtime tenants only. */
    public EnvironmentExecute(): EnvironmentCypherExecute
    {
        this.AssertRuntimePurpose()
        this.environmentExecute ??= new EnvironmentCypherExecute(this.EnvironmentEngine(), () => this.EnvironmentScopes(), new LoggerExecuteDiagnostics(this.options.logger ?? new NullLogger()))
        return this.environmentExecute
    }

    private async BuildEnvironmentScopes(): Promise<AccessScopeSource>
    {
        const host = this.EnvironmentEngine()
        const authorization = this.identity === undefined ? undefined : await this.ReadAuthorization()
        return new AccessScopeSource(host, new EnvironmentScopeRules(host, authorization, this.identity !== undefined), new LoggerScopeDiagnostics(this.options.logger ?? new NullLogger()))
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
     * The legacy per-app graph data/write, shares and assign still read their write targets from (Tasks 9-10 retire
     * it; `cypher/query` reads the environment engine): cached base graph, connector-backed concepts `labels` names
     * prefetched fresh per call, then the tenant security model's depth filter (widened by record shares). The
     * connector layer sits INSIDE the filter, so a connector-minted instance is filtered exactly like a native one.
     */
    public async GraphForPragmaticApp(context: AccessContext, name: string, labels: ReferencedLabelSet = PragmaticServer.NoLabels): Promise<IGraphQuery>
    {
        const built = await this.BaseGraphFor(name)
        const nativeBase = built.nativeBase
        const concepts = PragmaticServer.ConnectorConcepts(labels, built.plan, nativeBase)
        const services = this.root.Services()
        const shareIndex = await this.ShareIndexFor(context, name)
        const snapshot = concepts.length === 0
            ? new Map()
            : await ConnectorPrefetch.ForConcepts(concepts, built.plan, services.getRequired(DataSourceAdapterCatalog.ServiceKey), services, built.domain)
        const base = new ConnectorRuntimeGraphQuery(nativeBase, snapshot, built.defaultConcepts)
        const depth = await (await this.DepthFilterSource()).ReadFilterFor(context)
        const instanceFilter = shareIndex.IsEmpty()
            ? depth
            : new ShareWideningInstanceFilter(depth, shareIndex, ConceptIdFields.From(built.plan))
        return new FilteredGraphQuery(base, instanceFilter)
    }

    private async ShareServiceFor(context: AccessContext, name: string): Promise<ShareService>
    {
        if (this.identity === undefined)
        {
            throw new Error(PragmaticServer.SharingRequiresIdentityError)
        }
        let store: ShareStore
        try
        {
            store = this.AppShareStore(name)
        }
        catch
        {
            throw new Error(PragmaticServer.SharingRequiresStoreError)
        }
        const index = await this.ShareIndexFor(context, name)
        const evaluator = await (await this.ReadAuthorization()).EvaluatorForContext(context)
        const target = new FilteredReadWriteTargetSource(this, context, name)
        const idFields = ConceptIdFields.From((await this.BaseGraphFor(name)).plan)
        return new ShareService(store, index, evaluator, context.Principal, target, idFields)
    }

    public async ShareForPragmaticApp(context: AccessContext, name: string, params: ShareParams): Promise<ShareResultDto>
    {
        return (await this.ShareServiceFor(context, name)).Share(params)
    }

    public async UnshareForPragmaticApp(context: AccessContext, name: string, params: UnshareParams): Promise<UnshareResultDto>
    {
        return (await this.ShareServiceFor(context, name)).Unshare(params)
    }

    public async ListSharesForPragmaticApp(context: AccessContext, name: string, params: ListSharesParams): Promise<ListSharesResultDto>
    {
        return (await this.ShareServiceFor(context, name)).List(params)
    }

    private async AssignServiceFor(context: AccessContext, name: string): Promise<AssignService>
    {
        if (this.identity === undefined)
        {
            throw new Error(PragmaticServer.AssignRequiresIdentityError)
        }
        const built = await this.BaseGraphFor(name)
        const services = this.root.Services()
        const catalog = services.getRequired(DataSourceAdapterCatalog.ServiceKey)
        const index = await this.ShareIndexFor(context, name)
        const evaluator = await (await this.ReadAuthorization()).EvaluatorForContext(context)
        const target = new FilteredReadWriteTargetSource(this, context, name)
        const idFields = ConceptIdFields.From(built.plan)
        return new AssignService(evaluator, index, context.Principal, target, idFields, built.plan, catalog, services)
    }

    public async AssignForPragmaticApp(context: AccessContext, name: string, params: AssignParams): Promise<AssignResultDto>
    {
        return (await this.AssignServiceFor(context, name)).Assign(params)
    }

    public async WriteForPragmaticApp(context: AccessContext, name: string, operations: readonly AppWriteOpDto[]): Promise<AppWriteResultDto>
    {
        const built = await this.BaseGraphFor(name)
        const services = this.root.Services()
        const catalog = services.getRequired(DataSourceAdapterCatalog.ServiceKey)
        const baseAuthorizer = await (await this.WriteAuthorizerSource()).WriteAuthorizerFor(context)
        const shareIndex = await this.ShareIndexFor(context, name)
        const authorizer = shareIndex.IsEmpty() ? baseAuthorizer : new ShareWideningWriteAuthorizer(baseAuthorizer, shareIndex)
        const gate = await this.WriteInstanceGate(context, name)
        const writer = new RuntimeAppWriter(built.plan, built.nativeBase, catalog, services, authorizer, new RuntimeWritePayloadValidator(), gate)
        const result = await writer.Apply(operations)
        await this.RevokeSharesForDeletedRecords(name, operations, result)
        return result
    }

    /** Removes the share grants of every record whose delete was applied, so a recreated id is not widened by stale grants. */
    private async RevokeSharesForDeletedRecords(name: string, operations: readonly AppWriteOpDto[], result: AppWriteResultDto): Promise<void>
    {
        let store: ShareStore
        try
        {
            store = this.AppShareStore(name)
        }
        catch
        {
            return
        }
        for (let index = 0; index < operations.length; index++)
        {
            const op = operations[index]
            const outcome = result.results[index]
            if (op.op === AppWriteOpKind.Delete && op.id !== undefined && op.id.length > 0 && outcome?.status === AppWriteStatus.Applied)
            {
                await store.RevokeAllForRecord(op.concept, op.id)
            }
        }
    }

    /** Resolves the query's labels to the connector-backed concept ids to prefetch; a wildcard selects every connector concept. */
    private static ConnectorConcepts(labels: ReferencedLabelSet, plan: ModelConnectorPlan, base: IGraphQuery): string[]
    {
        if (labels.parseFailed || plan.Bindings.length === 0)
        {
            return []
        }
        if (labels.wildcard)
        {
            return [...new Set(plan.Bindings.map(b => b.Concept))]
        }
        const connectorConcepts = new Set(plan.Bindings.map(b => b.Concept))
        const result: string[] = []
        for (const label of labels.labels)
        {
            for (const full of PragmaticServer.ConceptIdsFor(label, base))
            {
                if (connectorConcepts.has(full) && !result.includes(full))
                {
                    result.push(full)
                }
            }
        }
        return result
    }

    /** Mirrors the Cypher engine's label resolution: an exact concept id, else every concept whose short name matches (ambiguity prefetches all candidates). */
    private static ConceptIdsFor(label: string, base: IGraphQuery): string[]
    {
        const exact = base.Type(label)
        if (exact !== undefined)
        {
            return [exact.fullName]
        }
        return base.Concepts()
            .map(c => c.fullName)
            .filter(full => full.substring(full.lastIndexOf(PragmaticServer.NamespaceSeparator) + 1) === label)
    }

    private async BaseGraphFor(name: string): Promise<AppBase>
    {
        const app = await this.Applications().ApplicationFor(name)
        // Key is name@version: packages are version-pinned, so republishing under the same app version is intentionally not re-read.
        const key = `${app.Manifest.name}${PragmaticServer.AppGraphKeySeparator}${app.Manifest.version}`
        let base = this.appGraphs.get(key)
        if (base === undefined)
        {
            const built = this.BuildBaseFor(app.Manifest)
            base = built
            this.appGraphs.set(key, built)
            // Evict a failed build so a later call retries (concurrent callers still share the in-flight promise).
            built.catch(() =>
            {
                if (this.appGraphs.get(key) === built)
                {
                    this.appGraphs.delete(key)
                }
            })
        }
        return base
    }

    private async BuildBaseFor(manifest: PragmaticAppManifest): Promise<AppBase>
    {
        const packagesStorage = this.PackagesStorage()
        const domain = await RuntimeAppGraph.BuildDomain(new StoragePackageSource(packagesStorage), manifest)
        const plan = await AppConnectorPlan.For(packagesStorage, manifest)
        const nativeBase = new GraphQuery(domain.Snapshot)
        const connectorName = `${PragmaticServer.BuiltinConnectorPrefix}${manifest.name}${PragmaticServer.AppGraphKeySeparator}${manifest.version}`
        const augmented = BuiltinBindings.Augment(plan, nativeBase, connectorName, this.DataRootFor(manifest.name), this.BuiltinEngine())
        return { domain, plan: augmented.plan, nativeBase, defaultConcepts: augmented.defaultConcepts }
    }

    /** The per-app record-share store (memoized), over the app's built-in document store. */
    public AppShareStore(name: string): ShareStore
    {
        let store = this.shareStores.get(name)
        if (store === undefined)
        {
            store = new ShareStore(this.platform.CreateAppDataStore(this.DataRootFor(name), this.BuiltinEngine()))
            this.shareStores.set(name, store)
        }
        return store
    }

    public async ShareIndexFor(context: AccessContext, name: string): Promise<ShareGrantIndex>
    {
        if (this.identity === undefined)
        {
            return ShareGrantIndex.Empty()
        }
        let store: ShareStore
        try
        {
            store = this.AppShareStore(name)
        }
        // Fail-closed: a store that can't be opened (e.g. Cloud, where CreateAppDataStore is unsupported) leaves sharing inactive rather than breaking reads/writes.
        catch
        {
            return ShareGrantIndex.Empty()
        }
        const membership = await (await this.ReadAuthorization()).MembershipFor(context)
        return ShareGrantIndex.For(store, context.Principal, membership)
    }

    /** The per-app built-in store directory: `<applicationsRoot>/<app>/data`, the path the platform's CreateAppDataStore consumes. */
    private DataRootFor(name: string): string
    {
        if (this.options.applicationsRoot === undefined)
        {
            throw new Error(PragmaticServer.ApplicationsRootRequiredError)
        }
        return join(this.options.applicationsRoot, name, PragmaticServer.AppDataDir)
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
     * The dev tenant's access scopes over {@link PragmaticServer.DevEngine}: with identity, the tenant security model
     * (AccessScopeSource under DevScopeRules), diagnostics on the configured logger. Built on first use, disposed
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
            // a failed build (the security source did not load) is retried by the next call
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
        const authorization = this.identity === undefined ? undefined : await this.ReadAuthorization()
        return new AccessScopeSource(engine, new DevScopeRules(engine, authorization, this.identity !== undefined, () => this.ActiveSolutionName()), new LoggerScopeDiagnostics(this.options.logger ?? new NullLogger()))
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
            // the scope source unsubscribes from the engine host and the security source before the host goes
            const environmentScopes = await this.environmentScopes?.catch(() => undefined)
            environmentScopes?.dispose()
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
                this.appGraphs.clear()
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
                        // the model view and the scope source unsubscribe from the engine host and the security source before the engine goes
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
