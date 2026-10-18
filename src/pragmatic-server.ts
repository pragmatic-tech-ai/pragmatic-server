import { join } from 'node:path'
import { LazyCompositionRoot, HostKinds, ModuleStateKind } from '@pragmatic-tech-ai/todl-runtime'
import { TenantPurpose } from './tenancy/tenant-purpose.js'
import type { ModuleStateProperty } from '@pragmatic-tech-ai/todl-runtime'
import { SolutionManagerService, StoragePackageSource, StoragePackageStore, PackageStoreKey, ConnectorPrefetch, ConnectorRuntimeGraphQuery, DataSourceAdapterCatalog } from '@pragmatic-tech-ai/todl'
import type { ModelConnectorPlan, IDataSourceAdapterProvider } from '@pragmatic-tech-ai/todl'
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
import { Action } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { IdentityEnforcement, PolicyCatalog, CompositeInstanceFilter, AllowAllInstanceFilter } from '@pragmatic-tech-ai/todl-identity-engine'
import { TenantReadAuthorization, AllowAllReadFilterSource, AllowAllFieldReadMaskSource } from './host/cypher/read-filter-source.js'
import { FieldMaskedGraphQuery, AllowAllFieldReadMask } from './host/cypher/field-masked-graph-query.js'
import { AllowAllWriteAuthorizerSource } from './host/cypher/read-filter-source.js'
import type { IReadFilterSource, IWriteAuthorizerSource, IFieldReadMaskSource } from './host/cypher/read-filter-source.js'
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
import { ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ShareService } from './host/sharing/share-service.js'
import { AssignService } from './host/sharing/assign-service.js'
import { AccessPolicySetting } from './host/apps/access-policy-setting.js'
import { FilteredGraphQuery } from './host/cypher/filtered-graph-query.js'
import { ModelShardGraph } from './host/cypher/model-shard-graph.js'
import { GraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { PragmaticAppsRegistry } from './host/apps/pragmatic-apps-registry.js'
import { RuntimeAppGraph } from './host/cypher/runtime-app-graph.js'
import { AppConnectorPlan } from './host/cypher/app-connector-plan.js'
import type { PragmaticAppManifest } from './host/apps/pragmatic-app-manifest.js'
import { TenantGraphCache } from './host/cypher/tenant-graph-cache.js'
import type { TenantRepository } from './host/cypher/tenant-graph-source.js'
import { ShareStore } from './host/sharing/share-store.js'
import { ShareGrantIndex } from './host/sharing/share-grant-index.js'
import { ShareWideningInstanceFilter } from './host/sharing/share-widening-instance-filter.js'
import { ConceptIdFields } from './host/sharing/concept-id-fields.js'
import { ShareWideningWriteInstanceGate } from './host/sharing/share-widening-write-instance-gate.js'
import { ShareWideningWriteAuthorizer } from './host/sharing/share-widening-write-authorizer.js'

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
    builtinStoreEngine?: BuiltinStoreEngine
    platform?: PlatformServices
    connectors?: ConnectorsHostOptions
    connectorsPolicy?: ConnectorsPolicy
    readonly adapterPacks?: AdapterPacksConfig
}

/** The node labels a Cypher query references; wildcard when any node pattern is unlabeled; parseFailed when the text is not valid Cypher (nothing is prefetched). */
export type ReferencedLabelSet = { labels: readonly string[]; wildcard: boolean; parseFailed: boolean }

type AppBase = { domain: Domain; plan: ModelConnectorPlan; nativeBase: IGraphQuery; defaultConcepts: ReadonlySet<string> }

/** Headless single-tenant in-process host: composes the engine over the lazy root and opens a solution. */
export class PragmaticServer
{
    private static readonly DefaultPackagesDir = 'packages'
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

    private static readonly GraphModelVersion = '0.0.0'
    private static readonly ModelNotFoundMessage = 'invalid params: model not found'

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
    private readonly appGraphs = new Map<string, Promise<AppBase>>()
    private readonly shareStores = new Map<string, ShareStore>()
    private readAuth: Promise<TenantReadAuthorization> | undefined

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
     *  depth authorizer plus the depth gate (connector rows have no per-app attribute policy, so the predicate is allow-all,
     *  mirroring the connector read filter). */
    public async ConnectorWriteAuthorizationFor(context: AccessContext, target: IWriteTargetSource): Promise<IHydrateAuthorization>
    {
        if (this.identity === undefined)
        {
            return ConnectorHydrateWriter.AllowAll()
        }
        // Connector rows have no app attribute policy, so the sharing predicate is allow-all and ownership is enforced solely by the depth evaluator, mirroring the depth-only connector READ side.
        const auth = await this.ReadAuthorization()
        return { authorizer: await auth.WriteAuthorizerFor(context), gate: await auth.WriteInstanceGateFor(context, new AllowAllInstanceFilter(), target) }
    }

    private async DepthFilterSource(): Promise<IReadFilterSource>
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
        const rules = await AccessPolicySetting.Load(this.AppsStorage(), name)
        const predicate = IdentityEnforcement.Over(PolicyCatalog.FromPolicies(rules), context, Action.Write).InstanceFilter()
        const target = new FilteredReadWriteTargetSource(this, context, name)
        const auth = await this.ReadAuthorization()
        const gate = await auth.WriteInstanceGateFor(context, predicate, target)
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

    public Applications(): PragmaticAppsRegistry
    {
        if (this.Purpose() !== TenantPurpose.Runtime)
        {
            throw new Error(PragmaticServer.ApplicationsRuntimeOnlyError)
        }
        this.appsRegistry ??= new PragmaticAppsRegistry(this.AppsStorage())
        return this.appsRegistry
    }

    /**
     * The policy-filtered graph for a bound application: cached base graph, connector-backed concepts the query references
     * prefetched fresh per query, then the SP-3b depth+predicate filter over the result. The connector layer sits INSIDE the filter,
     * so a connector-minted instance is filtered exactly like a native one.
     */
    public async GraphForPragmaticApp(context: AccessContext, name: string, labels: ReferencedLabelSet = PragmaticServer.NoLabels, maskFields = true): Promise<IGraphQuery>
    {
        const built = await this.BaseGraphFor(name)
        const nativeBase = built.nativeBase
        const concepts = PragmaticServer.ConnectorConcepts(labels, built.plan, nativeBase)
        const services = this.root.Services()
        const snapshot = concepts.length === 0
            ? new Map()
            : await ConnectorPrefetch.ForConcepts(concepts, built.plan, services.getRequired(DataSourceAdapterCatalog.ServiceKey), services, built.domain)
        const base = new ConnectorRuntimeGraphQuery(nativeBase, snapshot, built.defaultConcepts)
        const rules = await AccessPolicySetting.Load(this.AppsStorage(), name)
        const predicate = IdentityEnforcement.Over(PolicyCatalog.FromPolicies(rules), context, Action.Read).InstanceFilter()
        const depth = await (await this.DepthFilterSource()).ReadFilterFor(context)
        const composite = new CompositeInstanceFilter([predicate, depth])
        const shareIndex = await this.ShareIndexFor(context, name)
        const instanceFilter = shareIndex.IsEmpty()
            ? composite
            : new ShareWideningInstanceFilter(composite, shareIndex, ConceptIdFields.From(built.plan))
        const filtered = new FilteredGraphQuery(base, instanceFilter)
        if (!maskFields || this.identity === undefined)
        {
            return filtered
        }
        const mask = await (await this.ReadAuthorization()).FieldReadMaskFor(context)
        if (mask === AllowAllFieldReadMask.Instance)
        {
            return filtered
        }
        return new FieldMaskedGraphQuery(filtered, mask)
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
        return writer.Apply(operations)
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
        const packagesStorage = this.platform.CreateStorage(this.options.packagesRoot ?? PragmaticServer.DefaultPackagesDir)
        const domain = await RuntimeAppGraph.BuildDomain(new StoragePackageSource(packagesStorage), manifest)
        const plan = await AppConnectorPlan.For(packagesStorage, manifest)
        const nativeBase = new GraphQuery(domain.graph)
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
        const depthSource = await this.DepthFilterSource()
        this.graphCache ??= new TenantGraphCache(() => this.CollectGraphSources(), depthSource)
        return await this.graphCache.GraphFor(context)
    }

    /**
     * The queryable graph for ONE model shard of the active solution, RBAC-filtered and field-masked exactly like the
     * tenant-wide graph. An unknown model id and a shard the principal may not see raise the SAME InvalidParams error, so
     * existence is not leaked.
     */
    public async ModelGraph(context: AccessContext, modelId: string): Promise<IGraphQuery>
    {
        let owner: TenantRepository | undefined
        for (const source of await this.CollectGraphSources())
        {
            if (ModelShardGraph.Contains(source.repo, modelId))
            {
                owner = source
                break
            }
        }
        if (owner === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidParams, PragmaticServer.ModelNotFoundMessage)
        }
        const base = await ModelShardGraph.Build(owner.repo, modelId)
        const predicate = IdentityEnforcement.ForRepository(owner.repo, context, Action.Read).InstanceFilter()
        const depth = await (await this.DepthFilterSource()).ReadFilterFor(context)
        const filtered = new FilteredGraphQuery(base, new CompositeInstanceFilter([predicate, depth]))
        if (!ModelShardGraph.IsVisible(base, filtered))
        {
            throw new ResponseError(ErrorCodes.InvalidParams, PragmaticServer.ModelNotFoundMessage)
        }
        if (this.identity === undefined)
        {
            return filtered
        }
        const mask = await (await this.ReadAuthorization()).FieldReadMaskFor(context)
        return mask === AllowAllFieldReadMask.Instance ? filtered : new FieldMaskedGraphQuery(filtered, mask)
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
            await this.connectorsHost.Dispose()
        }
        finally
        {
            this.graphCache?.Dispose()
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
