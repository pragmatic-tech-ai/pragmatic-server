import {
    createMessageConnection, NullLogger, WebSocketMessageReader, WebSocketMessageWriter, LanguageProtocol, SolutionProtocol, ModelProtocol, ConnectorProtocol, AdminProtocol, CypherProtocol, PragmaticAppProtocol, GraphProtocol,
} from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection, IMessageSocket, ActiveSolutionSummary, ModelViewPageDto, ModelViewParams, ResolvedResourceDto, GrantDto, GrantMutationDto, IdentityConfigDto, SecurityModelDto, SetSecurityModelParams, AccountDto, CreateAccountParams, ServiceTokenSummaryDto, IssueTokenParams, TokenIssuedDto, CypherQueryParams, CypherQueryPageDto, CypherExecuteParams, CypherExecuteResultDto, PragmaticAppSummaryDto, GraphSummaryDto, GraphLoadParamsDto, GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ResponseError, ErrorCodes, DrainingError, ApplicationDeployProtocol, AppDataProtocol, DataSharingProtocol, DataAssignmentProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherAppDeployParamsDto, AppDeployResultDto, AppWriteParams, AppWriteResultDto, AppWriteOpDto, ShareParams, ShareResultDto, UnshareParams, UnshareResultDto, ListSharesParams, ListSharesResultDto, AssignParams, AssignResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { RequestType, NotificationType } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ResourceRef, IdentityConfig, PresentedSecret, LocalAccountNotFoundError } from '@pragmatic-tech-ai/todl-identity'
import { AccessDepthEvaluator } from '@pragmatic-tech-ai/todl-identity-engine'
import type { AccessContext, ISecurityModelConfig, Grant, Role, LocalAccount, ServiceTokenSummary, ServiceTokenGrant } from '@pragmatic-tech-ai/todl-identity'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { Cypher } from '@pragmatic-tech-ai/todl'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { ReferencedLabelSet } from '../pragmatic-server.js'
import { InvalidParamsPrefix } from './invalid-params-prefix.js'
import { PolicyGate } from './policy-gate.js'
import { AuditSurface } from './access-audit.js'
import type { IAccessAuditSink } from './access-audit.js'
import { RateLimitGuard } from './rate-limit-guard.js'
import { RateLimitScope } from './rate-limiter.js'
import { ConnectorService } from './connector-service.js'
import type { IConnectorReadAuthorization } from './connector-read-authorization.js'
import { ConnectorPrincipalDigest } from './connector-read-authorization.js'
import type { IHydrateAuthorization } from './connector-hydrate-writer.js'
import type { IWriteTargetSource } from './write-target-source.js'
import type { ConnectorRuntime } from '../connectors/connector-runtime.js'
import { ModelReadFilter } from './model-read-filter.js'
import { AllowAllFieldReadMaskSource } from './cypher/read-filter-source.js'
import type { IFieldReadMaskSource } from './cypher/read-filter-source.js'
import { AllowAllFieldReadMask, FieldMaskedGraphQuery } from './cypher/field-masked-graph-query.js'
import { AdminService, AdminSelfLockoutError, LastAdministratorError, AdminConfigMissingError, AdminTokenNotFoundError, ForeignTenantResourceError } from './admin-service.js'
import { AdminEnums, AdminEnumError } from './admin-enums.js'
import { TenantPurpose } from '../tenancy/tenant-purpose.js'
import type { IDevGraphService } from './graphs/dev-graph-service.js'
import { NoEnvironmentGraphError, type IEnvironmentGraphHost } from './graphs/environment-graph.js'
import type { PragmaticAppsRegistry } from './apps/pragmatic-apps-registry.js'
import { CypherLimits } from '../config/cypher-limits.js'
import { PagingLimits } from '../config/paging-limits.js'
import { PageFingerprint, PageRequest } from './paging/page-request.js'
import { BuildStateMapper } from './build-state-mapper.js'
import { CypherParamConverter, CypherParamError } from './cypher/cypher-param-converter.js'
import { AdapterPackError, AdapterPackErrorKind } from '@pragmatic-tech-ai/todl-connectors-host'
import type { DevCypherRequest } from './cypher/dev-cypher-executor.js'
import { CypherResultMapper } from './cypher/cypher-result-mapper.js'
import { trace } from '@opentelemetry/api'
import type { Context } from '@opentelemetry/api'
import type { RequestInstrumentation } from '../observability/request-instrumentation.js'

/** One client connection: wires every JSON-RPC handler 1:1 to the engine services and pushes notifications. */
export class ServerConnectionHandler
{
    private static readonly GenericInternalMessage = 'internal error'
    private static readonly NoActiveSolutionError = 'no active solution after open'
    private static readonly UnknownMemberError = 'unknown solution member'
    private static readonly DefaultResourceKind = 'Tenant'
    private static readonly InvalidConfigField = 'config'
    private static readonly SubjectField = 'subject'
    private static readonly ResourcePathField = 'resourcePath'
    private static readonly PackIdField = 'packId'
    private static readonly ProviderSettingsField = 'providerSettings'
    private static readonly GroupRoleMapField = 'groupRoleMap'
    private static readonly ClaimsMappingField = 'claimsMapping'
    private static readonly SecurityModelField = 'securityModel'
    private static readonly PrincipalIdField = 'principalId'
    private static readonly EmailField = 'email'
    private static readonly PasswordField = 'password'
    private static readonly TokenRefField = 'tokenRef'
    private static readonly PackNameField = 'name'
    private static readonly ScopesField = 'scopes'
    private static readonly ExpiresInField = 'expiresInSeconds'
    private static readonly EmailTakenMessage = 'email already registered'
    private static readonly PrincipalTakenMessage = 'principal already registered'
    private static readonly AccountExistsMessage = 'account already exists'
    private static readonly CypherField = 'cypher'
    private static readonly CypherTimeoutMessage = 'cypher query timed out'
    private static readonly PagedExplicitBoundsMessage = `${InvalidParamsPrefix.Text}paging cannot be combined with an explicit SKIP or LIMIT`
    private static readonly CypherFingerprintTag = 'cypher'
    private static readonly ModelScopeFingerprintTag = 'model'
    private static readonly ModelIdField = 'modelId'
    private static readonly RuntimeModelScopeMessage = `${InvalidParamsPrefix.Text}model-scoped query is not available on a runtime tenant`
    private static readonly ModelScopeUnavailableMessage = `${InvalidParamsPrefix.Text}model-scoped query not available`
    private static readonly ModelViewFingerprintTag = 'modelView'
    private static readonly NotRuntimeMessage = 'operation requires a runtime tenant'
    private static readonly ExecuteModelIdRequiredMessage = `${InvalidParamsPrefix.Text}modelId is required: a write must name its target model`
    private static readonly NotDevelopmentMessage = 'operation requires a development tenant'
    private static readonly GraphServiceUnavailableMessage = 'graph service is not available on this tenant'
    private static readonly EnvironmentGraphHostUnavailableMessage = 'environment graph host is not available on this tenant'
    private static readonly NameMismatchMessage = 'application manifest name does not match requested name: '
    private static readonly NoApplicationSelectedMessage = 'no application selected: call application/open first'
    private static readonly ApplicationsUnavailableMessage = 'pragmatic applications are not available on this connection'
    public static readonly RateLimitedCode = -32029
    public static readonly CypherTimeoutCode = -32030
    public static readonly RevokedCode = -32031
    private static readonly RevokedMessage = 'connection authorization has been revoked'

    private readonly connection: MessageConnection
    private readonly languageService: ILanguageService
    private readonly manager: SolutionManagerService
    private readonly accessContext: AccessContext
    private readonly gate: PolicyGate
    private readonly connectorService: ConnectorService
    private readonly graphSubscription: IDisposable
    private readonly buildStateSubscription: IDisposable
    private readonly instrumentation: RequestInstrumentation | undefined
    private readonly parent: Context | undefined
    private readonly rateLimit: RateLimitGuard | undefined
    private readonly admin: AdminService | undefined
    private readonly graphProvider: (context: AccessContext) => Promise<IGraphQuery>
    private readonly cypherLimits: CypherLimits
    private readonly paging: PagingLimits
    private readonly fieldMasks: IFieldReadMaskSource
    private readonly purpose: TenantPurpose
    private readonly modelGraphProvider: ((context: AccessContext, modelId: string) => Promise<IGraphQuery>) | undefined
    private readonly cypherExecuteProvider: ((context: AccessContext, modelId: string, request: DevCypherRequest) => Promise<CypherExecuteResultDto>) | undefined
    private readonly deployProvider: ((params: CypherAppDeployParamsDto) => Promise<AppDeployResultDto>) | undefined
    private readonly connectorReadAuthorization: ((context: AccessContext) => Promise<IConnectorReadAuthorization>) | undefined
    private readonly applications: PragmaticAppsRegistry | undefined
    private readonly appGraphProvider: ((context: AccessContext, name: string, labels: ReferencedLabelSet) => Promise<IGraphQuery>) | undefined
    private readonly appWriteProvider: ((context: AccessContext, name: string, operations: readonly AppWriteOpDto[]) => Promise<AppWriteResultDto>) | undefined
    private readonly shareProvider: ((context: AccessContext, name: string, params: ShareParams) => Promise<ShareResultDto>) | undefined
    private readonly unshareProvider: ((context: AccessContext, name: string, params: UnshareParams) => Promise<UnshareResultDto>) | undefined
    private readonly listSharesProvider: ((context: AccessContext, name: string, params: ListSharesParams) => Promise<ListSharesResultDto>) | undefined
    private readonly assignProvider: ((context: AccessContext, name: string, params: AssignParams) => Promise<AssignResultDto>) | undefined
    private readonly devGraphService: IDevGraphService | undefined
    private readonly environmentGraphHost: IEnvironmentGraphHost | undefined
    private boundApp: PragmaticAppSummaryDto | undefined
    private inFlight = 0
    private draining = false
    private revoked = false
    private disposed = false

    private constructor(connection: MessageConnection, languageService: ILanguageService, manager: SolutionManagerService, accessContext: AccessContext, connectorsFactory: () => Promise<ConnectorRuntime>, graphProvider: (context: AccessContext) => Promise<IGraphQuery>, instrumentation?: RequestInstrumentation, parent?: Context, audit?: IAccessAuditSink, rateLimit?: RateLimitGuard, admin?: AdminService, cypherLimits?: CypherLimits, purpose: TenantPurpose = TenantPurpose.Development, applications?: PragmaticAppsRegistry, appGraphProvider?: (context: AccessContext, name: string, labels: ReferencedLabelSet) => Promise<IGraphQuery>, appWriteProvider?: (context: AccessContext, name: string, operations: readonly AppWriteOpDto[]) => Promise<AppWriteResultDto>, shareProvider?: (context: AccessContext, name: string, params: ShareParams) => Promise<ShareResultDto>, unshareProvider?: (context: AccessContext, name: string, params: UnshareParams) => Promise<UnshareResultDto>, listSharesProvider?: (context: AccessContext, name: string, params: ListSharesParams) => Promise<ListSharesResultDto>, assignProvider?: (context: AccessContext, name: string, params: AssignParams) => Promise<AssignResultDto>, paging?: PagingLimits, fieldMasks?: IFieldReadMaskSource, connectorReadAuthorization?: (context: AccessContext) => Promise<IConnectorReadAuthorization>, connectorWriteAuthorization?: (context: AccessContext, target: IWriteTargetSource) => Promise<IHydrateAuthorization>, modelGraphProvider?: (context: AccessContext, modelId: string) => Promise<IGraphQuery>, cypherExecuteProvider?: (context: AccessContext, modelId: string, request: DevCypherRequest) => Promise<CypherExecuteResultDto>, deployProvider?: (params: CypherAppDeployParamsDto) => Promise<AppDeployResultDto>, devGraphService?: IDevGraphService, environmentGraphHost?: IEnvironmentGraphHost)
    {
        this.cypherLimits = cypherLimits ?? new CypherLimits()
        this.paging = paging ?? new PagingLimits()
        this.fieldMasks = fieldMasks ?? AllowAllFieldReadMaskSource.Instance
        this.purpose = purpose
        this.modelGraphProvider = modelGraphProvider
        this.cypherExecuteProvider = cypherExecuteProvider
        this.deployProvider = deployProvider
        this.devGraphService = devGraphService
        this.environmentGraphHost = environmentGraphHost
        this.connectorReadAuthorization = connectorReadAuthorization
        this.applications = applications
        this.appGraphProvider = appGraphProvider
        this.appWriteProvider = appWriteProvider
        this.shareProvider = shareProvider
        this.unshareProvider = unshareProvider
        this.listSharesProvider = listSharesProvider
        this.assignProvider = assignProvider
        this.rateLimit = rateLimit
        this.admin = admin
        this.graphProvider = graphProvider
        this.instrumentation = instrumentation
        this.parent = parent
        this.connectorService = new ConnectorService(connectorsFactory, connectorWriteAuthorization, connectorReadAuthorization)
        this.accessContext = accessContext
        this.connection = connection
        this.languageService = languageService
        this.manager = manager
        this.gate = new PolicyGate(accessContext, () =>
        {
            const solution = manager.ActiveSolution
            return solution === undefined ? [] : [solution.Name]
        }, audit)
        this.RegisterLanguageHandlers()
        this.RegisterSolutionHandlers()
        this.RegisterModelHandlers()
        this.RegisterConnectorHandlers()
        this.RegisterCypherHandlers()
        this.RegisterApplicationHandlers()
        this.RegisterGraphHandlers()
        this.RegisterAppDataHandlers()
        this.RegisterDataSharingHandlers()
        this.RegisterDataAssignmentHandlers()
        if (this.admin !== undefined)
        {
            this.RegisterAdminHandlers()
        }
        this.graphSubscription = languageService.GraphChanged.subscribe(async change =>
        {
            if (!this.gate.CanRead())
            {
                return
            }
            try
            {
                await connection.sendNotification(SolutionProtocol.GraphChanged, { memberIds: [...change.memberIds], fileIds: [...change.fileIds] })
            }
            catch
            {
                // fail-closed: a push to a closing connection must not crash the process
            }
        })
        this.buildStateSubscription = languageService.BuildStateChanged.subscribe(async state =>
        {
            if (!this.gate.CanRead())
            {
                return
            }
            try
            {
                await connection.sendNotification(SolutionProtocol.BuildStateChanged, { buildState: BuildStateMapper.ToWire(state) })
            }
            catch
            {
                // fail-closed: a push to a closing connection must not crash the process
            }
        })
    }

    /** The runtime-only Attach arguments (application registry + per-app graph provider); both undefined unless the server is a Runtime tenant. */
    public static RuntimeAttachArgs(server: { Purpose(): TenantPurpose; Applications(): PragmaticAppsRegistry; GraphForPragmaticApp(context: AccessContext, name: string, labels: ReferencedLabelSet): Promise<IGraphQuery>; WriteForPragmaticApp(context: AccessContext, name: string, operations: readonly AppWriteOpDto[]): Promise<AppWriteResultDto>; ShareForPragmaticApp(context: AccessContext, name: string, params: ShareParams): Promise<ShareResultDto>; UnshareForPragmaticApp(context: AccessContext, name: string, params: UnshareParams): Promise<UnshareResultDto>; ListSharesForPragmaticApp(context: AccessContext, name: string, params: ListSharesParams): Promise<ListSharesResultDto>; AssignForPragmaticApp(context: AccessContext, name: string, params: AssignParams): Promise<AssignResultDto>; DeployApplication(params: CypherAppDeployParamsDto): Promise<AppDeployResultDto>; LoadEnvironmentGraph(params: GraphLoadParamsDto): Promise<GraphLoadedDto>; LoadedGraph(): Promise<GraphLoadedDto | null>; EnvironmentGraphQuery(): Promise<IGraphQuery> }): { deployProvider: ((params: CypherAppDeployParamsDto) => Promise<AppDeployResultDto>) | undefined; applications: PragmaticAppsRegistry | undefined; appGraphProvider: ((context: AccessContext, name: string, labels: ReferencedLabelSet) => Promise<IGraphQuery>) | undefined; appWriteProvider: ((context: AccessContext, name: string, operations: readonly AppWriteOpDto[]) => Promise<AppWriteResultDto>) | undefined; shareProvider: ((context: AccessContext, name: string, params: ShareParams) => Promise<ShareResultDto>) | undefined; unshareProvider: ((context: AccessContext, name: string, params: UnshareParams) => Promise<UnshareResultDto>) | undefined; listSharesProvider: ((context: AccessContext, name: string, params: ListSharesParams) => Promise<ListSharesResultDto>) | undefined; assignProvider: ((context: AccessContext, name: string, params: AssignParams) => Promise<AssignResultDto>) | undefined; environmentGraphHost: IEnvironmentGraphHost | undefined }
    {
        if (server.Purpose() !== TenantPurpose.Runtime)
        {
            return { deployProvider: undefined, applications: undefined, appGraphProvider: undefined, appWriteProvider: undefined, shareProvider: undefined, unshareProvider: undefined, listSharesProvider: undefined, assignProvider: undefined, environmentGraphHost: undefined }
        }
        return { deployProvider: params => server.DeployApplication(params), applications: server.Applications(), appGraphProvider: (context, name, labels) => server.GraphForPragmaticApp(context, name, labels), appWriteProvider: (context, name, operations) => server.WriteForPragmaticApp(context, name, operations), shareProvider: (context, name, params) => server.ShareForPragmaticApp(context, name, params), unshareProvider: (context, name, params) => server.UnshareForPragmaticApp(context, name, params), listSharesProvider: (context, name, params) => server.ListSharesForPragmaticApp(context, name, params), assignProvider: (context, name, params) => server.AssignForPragmaticApp(context, name, params), environmentGraphHost: server }
    }

    /** The development-only Attach argument (the container-owned graph service); undefined unless the server is a Development tenant. */
    public static DevelopmentAttachArgs(server: { Purpose(): TenantPurpose; GraphService(): IDevGraphService }): { devGraphService: IDevGraphService | undefined }
    {
        return { devGraphService: server.Purpose() === TenantPurpose.Development ? server.GraphService() : undefined }
    }

    public static Attach(socket: IMessageSocket, languageService: ILanguageService, manager: SolutionManagerService, accessContext: AccessContext, connectorsFactory: () => Promise<ConnectorRuntime>, graphProvider: (context: AccessContext) => Promise<IGraphQuery>, instrumentation?: RequestInstrumentation, parent?: Context, audit?: IAccessAuditSink, rateLimit?: RateLimitGuard, admin?: AdminService, cypherLimits?: CypherLimits, purpose: TenantPurpose = TenantPurpose.Development, applications?: PragmaticAppsRegistry, appGraphProvider?: (context: AccessContext, name: string, labels: ReferencedLabelSet) => Promise<IGraphQuery>, appWriteProvider?: (context: AccessContext, name: string, operations: readonly AppWriteOpDto[]) => Promise<AppWriteResultDto>, shareProvider?: (context: AccessContext, name: string, params: ShareParams) => Promise<ShareResultDto>, unshareProvider?: (context: AccessContext, name: string, params: UnshareParams) => Promise<UnshareResultDto>, listSharesProvider?: (context: AccessContext, name: string, params: ListSharesParams) => Promise<ListSharesResultDto>, assignProvider?: (context: AccessContext, name: string, params: AssignParams) => Promise<AssignResultDto>, paging?: PagingLimits, fieldMasks?: IFieldReadMaskSource, connectorReadAuthorization?: (context: AccessContext) => Promise<IConnectorReadAuthorization>, connectorWriteAuthorization?: (context: AccessContext, target: IWriteTargetSource) => Promise<IHydrateAuthorization>, modelGraphProvider?: (context: AccessContext, modelId: string) => Promise<IGraphQuery>, cypherExecuteProvider?: (context: AccessContext, modelId: string, request: DevCypherRequest) => Promise<CypherExecuteResultDto>, deployProvider?: (params: CypherAppDeployParamsDto) => Promise<AppDeployResultDto>, devGraphService?: IDevGraphService, environmentGraphHost?: IEnvironmentGraphHost): ServerConnectionHandler
    {
        const connection = createMessageConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket), NullLogger)
        const handler = new ServerConnectionHandler(connection, languageService, manager, accessContext, connectorsFactory, graphProvider, instrumentation, parent, audit, rateLimit, admin, cypherLimits, purpose, applications, appGraphProvider, appWriteProvider, shareProvider, unshareProvider, listSharesProvider, assignProvider, paging, fieldMasks, connectorReadAuthorization, connectorWriteAuthorization, modelGraphProvider, cypherExecuteProvider, deployProvider, devGraphService, environmentGraphHost)
        connection.listen()
        return handler
    }

    /** Count of JSON-RPC requests currently executing on this connection (for drain). */
    public InFlight(): number
    {
        return this.inFlight
    }

    /** Puts the connection into draining state: new requests are rejected with the draining error; in-flight ones finish. */
    public BeginDrain(): void
    {
        this.draining = true
    }

    /** Force-closes the connection because its authorization was revoked: later dispatches report the revoked code. */
    public Revoke(): void
    {
        this.revoked = true
        this.BeginDrain()
        this.Dispose()
    }

    public Dispose(): void
    {
        if (this.disposed)
        {
            return
        }
        this.disposed = true
        this.graphSubscription.dispose()
        this.buildStateSubscription.dispose()
        this.connection.dispose()
    }

    private EnforceRate(method: string): void
    {
        if (this.rateLimit === undefined)
        {
            return
        }
        const decision = this.rateLimit.Check(
            { scope: RateLimitScope.Principal, tenant: this.accessContext.Tenant.Id, key: this.accessContext.Principal.Id },
            { surface: AuditSurface.Rpc, tenant: this.accessContext.Tenant.Id, principal: this.accessContext.Principal.Id, methodOrPath: method, correlationId: trace.getActiveSpan()?.spanContext().traceId })
        if (!decision.Allowed)
        {
            throw new ResponseError(ServerConnectionHandler.RateLimitedCode, RateLimitGuard.RejectedReason, { retryAfterMs: decision.RetryAfterMs })
        }
    }

    private authorize(method: string): void
    {
        const decision = this.gate.Authorize(method)
        if (!decision.Allowed)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, decision.Reason)
        }
    }

    private Dispatch<R>(method: string, operation: () => R | Promise<R>): R | Promise<R>
    {
        if (this.revoked)
        {
            throw new ResponseError(ServerConnectionHandler.RevokedCode, ServerConnectionHandler.RevokedMessage)
        }
        if (this.draining)
        {
            throw new ResponseError(DrainingError.Code, DrainingError.Message)
        }
        this.inFlight++
        const settle = <T>(value: T): T =>
        {
            this.inFlight--
            return value
        }
        const fail = (error: unknown): never =>
        {
            this.inFlight--
            throw error instanceof ResponseError ? error : new ResponseError(ErrorCodes.InternalError, ServerConnectionHandler.GenericInternalMessage)
        }
        try
        {
            const result = this.instrumentation === undefined
                ? operation()
                : this.instrumentation.Run({ method, tenant: this.accessContext.Tenant.Id, principal: this.accessContext.Principal.Id }, operation, this.parent)
            return result instanceof Promise ? result.then(settle, fail) : settle(result)
        }
        catch (error)
        {
            return fail(error)
        }
    }

    private guarded<P, R, E>(type: RequestType<P, R, E>, handler: (params: P) => R | Promise<R>): void
    {
        this.connection.onRequest(type, (params: P) => this.Dispatch(type.method, () =>
        {
            this.EnforceRate(type.method)
            this.authorize(type.method)
            return handler(params)
        }))
    }

    private guardedNoParams(type: typeof SolutionProtocol.ActiveSolution, handler: () => ActiveSolutionSummary | null): void
    private guardedNoParams(type: typeof PragmaticAppProtocol.List, handler: () => PragmaticAppSummaryDto[] | Promise<PragmaticAppSummaryDto[]>): void
    private guardedNoParams(type: typeof GraphProtocol.List, handler: () => GraphSummaryDto[] | Promise<GraphSummaryDto[]>): void
    private guardedNoParams(type: typeof GraphProtocol.Loaded, handler: () => (GraphLoadedDto | null) | Promise<GraphLoadedDto | null>): void
    private guardedNoParams(type: typeof SolutionProtocol.ActiveSolution | typeof PragmaticAppProtocol.List | typeof GraphProtocol.List | typeof GraphProtocol.Loaded, handler: () => unknown): void
    {
        this.connection.onRequest(type as typeof SolutionProtocol.ActiveSolution, () => this.Dispatch(type.method, () =>
        {
            this.EnforceRate(type.method)
            this.authorize(type.method)
            return handler() as ActiveSolutionSummary | null
        }))
    }

    private guardedNotification<P>(type: NotificationType<P>, handler: (params: P) => void): void
    {
        this.connection.onNotification(type, (params: P) =>
        {
            if (this.gate.Authorize(type.method).Allowed)
            {
                handler(params)
            }
        })
    }

    private RegisterLanguageHandlers(): void
    {
        const service = this.languageService
        this.guarded(LanguageProtocol.CompletionsAt, p => service.CompletionsAt(p.uri, p.position))
        this.guarded(LanguageProtocol.HoverAt, p => service.HoverAt(p.uri, p.position))
        this.guarded(LanguageProtocol.DefinitionAt, p => service.DefinitionAt(p.uri, p.position))
        this.guarded(LanguageProtocol.ReferencesAt, p => service.ReferencesAt(p.uri, p.position, p.includeDeclaration))
        this.guarded(LanguageProtocol.PrepareRename, p => service.PrepareRename(p.uri, p.position))
        this.guarded(LanguageProtocol.RenameEdits, p => service.RenameEdits(p.uri, p.position, p.newName))
        this.guarded(LanguageProtocol.DocumentSymbols, p => service.DocumentSymbols(p.uri))
        this.guarded(LanguageProtocol.FoldingRanges, p => service.FoldingRanges(p.uri))
        this.guarded(LanguageProtocol.WorkspaceSymbols, p => service.WorkspaceSymbols(p.query))
        this.guarded(LanguageProtocol.SemanticTokens, p => service.SemanticTokens(p.uri))
        this.guarded(LanguageProtocol.SignatureHelpAt, p => service.SignatureHelpAt(p.uri, p.position))
        this.guarded(LanguageProtocol.CodeActions, p => service.CodeActions(p.uri, p.range, p.diagnostics as Parameters<ILanguageService['CodeActions']>[2]))
        this.guarded(LanguageProtocol.FormatDocument, p => service.FormatDocument(p.uri))
        this.guarded(LanguageProtocol.DiagnosticsFor, p => service.DiagnosticsFor(p.uri))
        this.guardedNotification(LanguageProtocol.DidChange, p => void this.PublishDiagnostics(p.uri, p.text))
    }

    private RegisterModelHandlers(): void
    {
        this.guarded(ModelProtocol.ModelView, p => this.ProjectModelView(p))
        this.guarded(ModelProtocol.Resources, async p =>
        {
            if (await this.ResourceHidden(p.nodeId))
            {
                return []
            }
            const resources = await this.languageService.Resources(p.nodeId)
            const dtos: ResolvedResourceDto[] = resources.map(r => ({ annotation: r.annotation, path: r.path, storageRoot: r.storage.Root }))
            return dtos
        })
    }

    private RegisterConnectorHandlers(): void
    {
        this.connection.onRequest(ConnectorProtocol.List, () => this.Dispatch(ConnectorProtocol.List.method, () =>
        {
            this.EnforceRate(ConnectorProtocol.List.method)
            this.authorize(ConnectorProtocol.List.method)
            return this.connectorService.List()
        }))
        this.connection.onRequest(ConnectorProtocol.Refresh, () => this.Dispatch(ConnectorProtocol.Refresh.method, async () =>
        {
            this.EnforceRate(ConnectorProtocol.Refresh.method)
            this.authorize(ConnectorProtocol.Refresh.method)
            await this.connectorService.Invalidate()
        }))
        this.guarded(ConnectorProtocol.Prepare, p => this.connectorService.Prepare(p.modelId))
        this.guarded(ConnectorProtocol.Read, p => this.connectorService.Read(p.modelId, p.concept, p, this.paging, this.accessContext))
        this.guarded(ConnectorProtocol.ReadPage, p => this.connectorService.ReadPage(p.modelId, p.concept, p, this.paging, this.accessContext))
        this.guarded(ConnectorProtocol.RefreshModel, p => this.connectorService.RefreshModel(p.modelId))
        this.guarded(ConnectorProtocol.WritePaged, p => this.connectorService.WritePaged(p, this.accessContext))
        this.guarded(ConnectorProtocol.WriteBack, p => this.connectorService.WriteBack(p))
        this.guarded(ConnectorProtocol.Test, p => this.connectorService.Test(p.modelId, p.connectorName))
    }

    private RegisterCypherHandlers(): void
    {
        this.guarded(CypherProtocol.Query, p => this.RunCypherQuery(p))
        this.guarded(CypherProtocol.Execute, p => this.RunCypherExecute(p))
    }

    private RegisterAppDataHandlers(): void
    {
        this.guarded(AppDataProtocol.Write, p => this.RunAppDataWrite(p))
    }

    private RegisterDataSharingHandlers(): void
    {
        this.guarded(DataSharingProtocol.Share, p => this.RunShare(p))
        this.guarded(DataSharingProtocol.Unshare, p => this.RunUnshare(p))
        this.guarded(DataSharingProtocol.ListShares, p => this.RunListShares(p))
    }

    public async RunShare(params: ShareParams): Promise<ShareResultDto>
    {
        this.EnsureRuntime()
        if (this.boundApp === undefined || this.shareProvider === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.NoApplicationSelectedMessage)
        }
        return this.shareProvider(this.accessContext, this.boundApp.name, params)
    }

    public async RunUnshare(params: UnshareParams): Promise<UnshareResultDto>
    {
        this.EnsureRuntime()
        if (this.boundApp === undefined || this.unshareProvider === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.NoApplicationSelectedMessage)
        }
        return this.unshareProvider(this.accessContext, this.boundApp.name, params)
    }

    public async RunListShares(params: ListSharesParams): Promise<ListSharesResultDto>
    {
        this.EnsureRuntime()
        if (this.boundApp === undefined || this.listSharesProvider === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.NoApplicationSelectedMessage)
        }
        return this.listSharesProvider(this.accessContext, this.boundApp.name, params)
    }

    private RegisterDataAssignmentHandlers(): void
    {
        this.guarded(DataAssignmentProtocol.Assign, p => this.RunAssign(p))
    }

    public async RunAssign(params: AssignParams): Promise<AssignResultDto>
    {
        this.EnsureRuntime()
        if (this.boundApp === undefined || this.assignProvider === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.NoApplicationSelectedMessage)
        }
        return this.assignProvider(this.accessContext, this.boundApp.name, params)
    }

    public async RunDeploy(params: CypherAppDeployParamsDto): Promise<AppDeployResultDto>
    {
        this.EnsureRuntime()
        if (this.deployProvider === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.NotRuntimeMessage)
        }
        return this.deployProvider(params)
    }

    public async RunAppDataWrite(params: AppWriteParams): Promise<AppWriteResultDto>
    {
        this.EnsureRuntime()
        if (this.boundApp === undefined || this.appWriteProvider === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.NoApplicationSelectedMessage)
        }
        const operations: readonly AppWriteOpDto[] = params?.operations ?? []
        return this.appWriteProvider(this.accessContext, this.boundApp.name, operations)
    }

    public async RunCypherQuery(params: CypherQueryParams): Promise<CypherQueryPageDto>
    {
        const source = this.RequireNonEmptyString(params?.cypher, ServerConnectionHandler.CypherField)
        PageRequest.ValidatePageSize(params)
        this.RefuseExplicitBoundsWhenPaged(source, params)
        let parameters: ReadonlyMap<string, Cypher.ParameterValue>
        try
        {
            parameters = CypherParamConverter.ToMap(params.parameters)
        }
        catch (error)
        {
            if (error instanceof CypherParamError)
            {
                throw new ResponseError(ErrorCodes.InvalidParams, `${InvalidParamsPrefix.Text}${error.message}`)
            }
            throw error
        }
        const modelId = params.modelId === undefined ? undefined : this.RequireNonEmptyString(params.modelId, ServerConnectionHandler.ModelIdField)
        if (modelId !== undefined && this.purpose === TenantPurpose.Runtime)
        {
            throw new ResponseError(ErrorCodes.InvalidParams, ServerConnectionHandler.RuntimeModelScopeMessage)
        }
        const graph = this.purpose === TenantPurpose.Runtime
            ? this.boundApp !== undefined
                ? await this.RequireBoundAppGraph(Cypher.ReferencedLabels.Of(source))
                : await this.RequireEnvironmentGraph()
            : modelId === undefined
                ? await this.MaskedTenantGraph()
                : await this.RequireModelGraph(modelId)
        // read the revision only once the graph is in hand: acquiring it may itself commit the first build, so
        // reading GraphRevision before the fetch would fingerprint page 1 against the pre-build revision and
        // page 2 would then always be rejected as stale
        const parts = [ServerConnectionHandler.CypherFingerprintTag, source, CypherParamConverter.Canonical(params.parameters), String(this.languageService.GraphRevision)]
        if (modelId !== undefined)
        {
            parts.push(ServerConnectionHandler.ModelScopeFingerprintTag, modelId)
            if (await this.IdentityBacked())
            {
                parts.push(ConnectorPrincipalDigest.Of(this.accessContext))
            }
        }
        const fingerprint = PageFingerprint.Of(...parts)
        const page = PageRequest.Resolve(params, fingerprint, this.paging, this.cypherLimits.RowCap)
        try
        {
            const engine = Cypher.CypherEngine.OverQuery(graph, { MaxVarLength: this.cypherLimits.MaxVarLength })
            const result = engine.Execute(source, parameters, { Skip: page.Offset, RowCap: page.Size, Cancel: Cypher.Deadline.After(this.cypherLimits.TimeoutMs) })
            return CypherResultMapper.ToWire(Cypher.CypherEngine.ToDto(result), page.NextCursor(result.HasMore))
        }
        catch (error)
        {
            if (error instanceof Cypher.CypherSyntaxError || error instanceof Cypher.CypherSemanticError)
            {
                throw new ResponseError(ErrorCodes.InvalidParams, `${InvalidParamsPrefix.Text}${error.message}`)
            }
            if (error instanceof Cypher.CypherTimeout)
            {
                throw new ResponseError(ServerConnectionHandler.CypherTimeoutCode, ServerConnectionHandler.CypherTimeoutMessage)
            }
            throw error
        }
    }

    /** `modelId` must be the round-trip-stable canonical model id (`<namespace>Model`): a non-canonical author name is renamed on first write (TODL emitter convention) and the id changes. */
    public async RunCypherExecute(params: CypherExecuteParams): Promise<CypherExecuteResultDto>
    {
        this.EnsureDevelopment()
        params ??= {} as CypherExecuteParams
        const source = this.RequireNonEmptyString(params?.cypher, ServerConnectionHandler.CypherField)
        let parameters: ReadonlyMap<string, Cypher.ParameterValue>
        try
        {
            parameters = CypherParamConverter.ToMap(params.parameters)
        }
        catch (error)
        {
            if (error instanceof CypherParamError)
            {
                throw new ResponseError(ErrorCodes.InvalidParams, `${InvalidParamsPrefix.Text}${error.message}`)
            }
            throw error
        }
        if (params.modelId === undefined || params.modelId === null)
        {
            throw new ResponseError(ErrorCodes.InvalidParams, ServerConnectionHandler.ExecuteModelIdRequiredMessage)
        }
        const modelId = this.RequireNonEmptyString(params.modelId, ServerConnectionHandler.ModelIdField)
        if (this.cypherExecuteProvider === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidParams, ServerConnectionHandler.ModelScopeUnavailableMessage)
        }
        const request: DevCypherRequest = { cypher: source, parameters, timeoutMs: this.cypherLimits.TimeoutMs, maxVarLength: this.cypherLimits.MaxVarLength }
        if (params.expectedRevision !== undefined && params.expectedRevision !== null)
        {
            request.expectedRevision = params.expectedRevision
        }
        try
        {
            return await this.cypherExecuteProvider(this.accessContext, modelId, request)
        }
        catch (error)
        {
            if (error instanceof Cypher.CypherSyntaxError || error instanceof Cypher.CypherSemanticError)
            {
                throw new ResponseError(ErrorCodes.InvalidParams, `${InvalidParamsPrefix.Text}${error.message}`)
            }
            if (error instanceof Cypher.CypherTimeout)
            {
                throw new ResponseError(ServerConnectionHandler.CypherTimeoutCode, ServerConnectionHandler.CypherTimeoutMessage)
            }
            throw error
        }
    }

    /**
     * A paged request translates to engine Skip/RowCap, so a tail SKIP/LIMIT in the text would double-offset: refuse it.
     * Judges ONLY the FINAL QueryPart.Projection: an interior WITH ... LIMIT is query-internal and intentionally allowed;
     * only a tail SKIP/LIMIT conflicts with paging.
     */
    private RefuseExplicitBoundsWhenPaged(source: string, params: CypherQueryParams): void
    {
        const paged = (params.cursor !== undefined && params.cursor !== null) || (params.pageSize !== undefined && params.pageSize !== null)
        if (!paged)
        {
            return
        }
        try
        {
            const parts = new Cypher.CypherParser(source).Parse().Parts
            const last = parts[parts.length - 1]?.Projection
            if (last !== undefined && (last.Skip !== undefined || last.Limit !== undefined))
            {
                throw new ResponseError(ErrorCodes.InvalidParams, ServerConnectionHandler.PagedExplicitBoundsMessage)
            }
        }
        catch (error)
        {
            if (error instanceof Cypher.CypherSyntaxError || error instanceof Cypher.CypherSemanticError)
            {
                throw new ResponseError(ErrorCodes.InvalidParams, `${InvalidParamsPrefix.Text}${error.message}`)
            }
            throw error
        }
    }

    /** The tenant-wide dev graph behind the per-context field mask, so every Cypher graph path masks uniformly. */
    private async MaskedTenantGraph(): Promise<IGraphQuery>
    {
        const graph = await this.graphProvider(this.accessContext)
        const mask = await this.fieldMasks.FieldReadMaskFor(this.accessContext)
        return mask === AllowAllFieldReadMask.Instance ? graph : new FieldMaskedGraphQuery(graph, mask)
    }

    private async RequireModelGraph(modelId: string): Promise<IGraphQuery>
    {
        if (this.modelGraphProvider === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidParams, ServerConnectionHandler.ModelScopeUnavailableMessage)
        }
        return await this.modelGraphProvider(this.accessContext, modelId)
    }

    /** True only with a real identity subsystem: the principal digest then joins the model-scoped cursor fingerprint. */
    private async IdentityBacked(): Promise<boolean>
    {
        return this.connectorReadAuthorization !== undefined && (await this.connectorReadAuthorization(this.accessContext)).IdentityBacked
    }

    private RegisterApplicationHandlers(): void
    {
        this.guardedNoParams(PragmaticAppProtocol.List, async () =>
        {
            this.EnsureRuntime()
            const summaries = await this.RequireApplications().List()
            return summaries.map(a => ({ name: a.name, version: a.version }))
        })
        this.guarded(ApplicationDeployProtocol.Deploy, p => this.RunDeploy(p))
        this.guarded(PragmaticAppProtocol.Open, async p =>
        {
            this.EnsureRuntime()
            const app = await this.RequireApplications().ApplicationFor(p.name)
            if (app.Manifest.name !== p.name)
            {
                throw new ResponseError(ErrorCodes.InvalidParams, ServerConnectionHandler.NameMismatchMessage + p.name)
            }
            this.boundApp = { name: app.Manifest.name, version: app.Manifest.version }
            return this.boundApp
        })
    }

    private RegisterGraphHandlers(): void
    {
        this.guarded(GraphProtocol.Create, async p =>
        {
            this.EnsureDevelopment()
            return await this.RequireGraphService().CreateGraph(p)
        })
        this.guardedNoParams(GraphProtocol.List, async () =>
        {
            this.EnsureDevelopment()
            return await this.RequireGraphService().ListGraphs()
        })
        this.guarded(GraphProtocol.Get, async p =>
        {
            this.EnsureDevelopment()
            return await this.RequireGraphService().GetGraph(p)
        })
        this.guarded(GraphProtocol.Delete, async p =>
        {
            this.EnsureDevelopment()
            await this.RequireGraphService().DeleteGraph(p)
        })
        this.guarded(GraphProtocol.Contribute, async p =>
        {
            this.EnsureDevelopment()
            return await this.RequireGraphService().ContributeGraph(p)
        })
        this.guarded(GraphProtocol.Export, async p =>
        {
            this.EnsureDevelopment()
            return await this.RequireGraphService().ExportGraph(p)
        })
        this.guarded(GraphProtocol.Load, async p =>
        {
            this.EnsureRuntime()
            return await this.RequireEnvironmentGraphHost().LoadEnvironmentGraph(p)
        })
        this.guardedNoParams(GraphProtocol.Loaded, async () =>
        {
            this.EnsureRuntime()
            return await this.RequireEnvironmentGraphHost().LoadedGraph()
        })
    }

    private RequireGraphService(): IDevGraphService
    {
        if (this.devGraphService === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.GraphServiceUnavailableMessage)
        }
        return this.devGraphService
    }

    private RequireEnvironmentGraphHost(): IEnvironmentGraphHost
    {
        if (this.environmentGraphHost === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.EnvironmentGraphHostUnavailableMessage)
        }
        return this.environmentGraphHost
    }

    private async RequireEnvironmentGraph(): Promise<IGraphQuery>
    {
        try
        {
            return await this.RequireEnvironmentGraphHost().EnvironmentGraphQuery()
        }
        catch (error)
        {
            if (error instanceof NoEnvironmentGraphError)
            {
                throw new ResponseError(ErrorCodes.InvalidRequest, error.message)
            }
            throw error
        }
    }

    private EnsureRuntime(): void
    {
        if (this.purpose !== TenantPurpose.Runtime)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.NotRuntimeMessage)
        }
    }

    private EnsureDevelopment(): void
    {
        if (this.purpose !== TenantPurpose.Development)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.NotDevelopmentMessage)
        }
    }

    private RequireApplications(): PragmaticAppsRegistry
    {
        if (this.applications === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.ApplicationsUnavailableMessage)
        }
        return this.applications
    }

    private async RequireBoundAppGraph(labels: ReferencedLabelSet): Promise<IGraphQuery>
    {
        if (this.boundApp === undefined || this.appGraphProvider === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.NoApplicationSelectedMessage)
        }
        return this.appGraphProvider(this.accessContext, this.boundApp.name, labels)
    }

    private RegisterAdminHandlers(): void
    {
        const admin = this.admin as AdminService
        this.guarded(AdminProtocol.ListGrants, async p => (await this.AdminCall(() => admin.ListGrants(this.RequireSubject(p.subject)))).map(g => this.ToGrantDto(g)))
        this.guarded(AdminProtocol.GrantRole, async p =>
        {
            const { subject, role, resource } = this.ParseMutation(p)
            await this.AdminCall(() => admin.GrantRole(this.actor(), subject, role, resource))
            return { ok: true as const }
        })
        this.guarded(AdminProtocol.RevokeRole, async p =>
        {
            const { subject, role, resource } = this.ParseMutation(p)
            await this.AdminCall(() => admin.RevokeRole(this.actor(), subject, role, resource))
            return { ok: true as const }
        })
        this.connection.onRequest(AdminProtocol.GetConfig, () => this.Dispatch(AdminProtocol.GetConfig.method, async () =>
        {
            this.EnforceRate(AdminProtocol.GetConfig.method)
            this.authorize(AdminProtocol.GetConfig.method)
            return this.ToConfigDto(await this.AdminCall(() => admin.GetConfig()))
        }))
        this.guarded(AdminProtocol.SetConfig, async p =>
        {
            const config = this.ParseConfigDto(p)
            await this.AdminCall(() => admin.SetConfig(this.actor(), config))
            return { ok: true as const }
        })
        this.connection.onRequest(AdminProtocol.GetSecurityModel, () => this.Dispatch(AdminProtocol.GetSecurityModel.method, async () =>
        {
            this.EnforceRate(AdminProtocol.GetSecurityModel.method)
            this.authorize(AdminProtocol.GetSecurityModel.method)
            // ISecurityModelConfig and SecurityModelDto are field-identical, JSON-safe shapes.
            return await this.AdminCall(() => admin.GetSecurityModel()) as SecurityModelDto | undefined
        }))
        this.guarded(AdminProtocol.SetSecurityModel, async p =>
        {
            const model = this.ParseSecurityModel(p)
            await this.AdminCall(() => admin.SetSecurityModel(this.actor(), model))
            return { ok: true as const }
        })
        this.connection.onRequest(AdminProtocol.ListAccounts, () => this.Dispatch(AdminProtocol.ListAccounts.method, async () =>
        {
            this.EnforceRate(AdminProtocol.ListAccounts.method)
            this.authorize(AdminProtocol.ListAccounts.method)
            return (await this.AdminCall(() => admin.ListAccounts())).map(a => this.ToAccountDto(a))
        }))
        this.guarded(AdminProtocol.CreateAccount, async p =>
        {
            const { email, principalId } = this.ParseCreateAccount(p)
            const presented = new PresentedSecret(this.RequireNonEmptyString(p?.password, ServerConnectionHandler.PasswordField))
            try
            {
                await this.AdminCall(() => admin.CreateAccount(this.actor(), email, principalId, presented))
            }
            catch (error)
            {
                throw this.MapCreateError(error)
            }
            finally
            {
                presented.Clear()
            }
            return { ok: true as const }
        })
        this.guarded(AdminProtocol.DisableAccount, async p =>
        {
            const principalId = this.RequirePrincipalId(p?.principalId)
            await this.AdminCall(() => admin.DisableAccount(this.actor(), principalId))
            return { ok: true as const }
        })
        this.connection.onRequest(AdminProtocol.ListTokens, () => this.Dispatch(AdminProtocol.ListTokens.method, async () =>
        {
            this.EnforceRate(AdminProtocol.ListTokens.method)
            this.authorize(AdminProtocol.ListTokens.method)
            return (await this.AdminCall(() => admin.ListTokens())).map(t => this.ToServiceTokenSummaryDto(t))
        }))
        this.guarded(AdminProtocol.IssueToken, async p =>
        {
            const { principalId, scopes, expiresAt } = this.ParseIssueToken(p)
            const issued = await this.AdminCall(() => admin.IssueToken(this.actor(), principalId, scopes, expiresAt))
            return this.ToTokenIssuedDto(issued)
        })
        this.guarded(AdminProtocol.RevokeToken, async p =>
        {
            const tokenRef = this.RequireTokenRef(p?.tokenRef)
            await this.AdminCall(() => admin.RevokeToken(this.actor(), tokenRef))
            return { ok: true as const }
        })
        this.guarded(AdminProtocol.InvalidatePack, async p =>
        {
            const name = this.RequirePackName(p?.name)
            await this.AdminCall(() => admin.InvalidatePack(this.actor(), name))
            return { ok: true as const }
        })
        this.connection.onRequest(AdminProtocol.ListScriptAllowlist, () => this.Dispatch(AdminProtocol.ListScriptAllowlist.method, async () =>
        {
            this.EnforceRate(AdminProtocol.ListScriptAllowlist.method)
            this.authorize(AdminProtocol.ListScriptAllowlist.method)
            return { names: [...await this.AdminCall(() => admin.ListScriptAllowlist())] }
        }))
        this.guarded(AdminProtocol.AllowPackScripts, async p =>
        {
            const name = this.RequirePackName(p?.name)
            await this.AdminCall(() => admin.AllowPackScripts(this.actor(), name))
            return { ok: true as const }
        })
        this.guarded(AdminProtocol.DenyPackScripts, async p =>
        {
            const name = this.RequirePackName(p?.name)
            await this.AdminCall(() => admin.DenyPackScripts(this.actor(), name))
            return { ok: true as const }
        })
    }

    private actor(): string
    {
        return this.accessContext.Principal.Id
    }

    private async AdminCall<T>(operation: () => Promise<T>): Promise<T>
    {
        try
        {
            return await operation()
        }
        catch (error)
        {
            if (error instanceof AdminSelfLockoutError || error instanceof LastAdministratorError || error instanceof AdminConfigMissingError || error instanceof LocalAccountNotFoundError || error instanceof AdminTokenNotFoundError || error instanceof ForeignTenantResourceError)
            {
                throw new ResponseError(ErrorCodes.InvalidRequest, error.message)
            }
            if (error instanceof AdapterPackError && error.Kind === AdapterPackErrorKind.ProviderNotConfigured)
            {
                throw new ResponseError(ErrorCodes.InvalidRequest, error.message)
            }
            throw error
        }
    }

    private InvalidParams(error: unknown): ResponseError<void>
    {
        if (error instanceof ResponseError)
        {
            return error
        }
        const field = error instanceof AdminEnumError ? error.Field : ServerConnectionHandler.InvalidConfigField
        return new ResponseError(ErrorCodes.InvalidParams, `${InvalidParamsPrefix.Text}${field}`)
    }

    private ParseMutation(dto: GrantMutationDto): { subject: string, role: Role, resource: ResourceRef }
    {
        try
        {
            const subject = this.RequireSubject(dto.subject)
            const role = AdminEnums.RoleFromName(dto.role)
            const kind = AdminEnums.ResourceKindFromName(dto.resourceKind ?? ServerConnectionHandler.DefaultResourceKind)
            const path = dto.resourcePath === undefined ? [] : this.RequireStringArray(dto.resourcePath, ServerConnectionHandler.ResourcePathField)
            return { subject, role, resource: new ResourceRef(kind, this.accessContext.Tenant.Id, path) }
        }
        catch (error)
        {
            throw this.InvalidParams(error)
        }
    }

    private RequireSubject(value: unknown): string
    {
        return this.RequireNonEmptyString(value, ServerConnectionHandler.SubjectField)
    }

    private RequirePackName(name: unknown): string
    {
        const value = this.RequireNonEmptyString(name, ServerConnectionHandler.PackNameField)
        if (value.trim().length === 0)
        {
            throw this.InvalidParams(new AdminEnumError(ServerConnectionHandler.PackNameField))
        }
        return value
    }

    private RequireNonEmptyString(value: unknown, field: string): string
    {
        if (typeof value !== 'string' || value.length === 0)
        {
            throw this.InvalidParams(new AdminEnumError(field))
        }
        return value
    }

    private RequireStringArray(value: unknown, field: string): string[]
    {
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string'))
        {
            throw this.InvalidParams(new AdminEnumError(field))
        }
        return [...value]
    }

    private RequireStringRecord(value: unknown, field: string): Map<string, string>
    {
        const proto = typeof value === 'object' && value !== null ? Object.getPrototypeOf(value) : undefined
        if (typeof value !== 'object' || value === null || Array.isArray(value) || (proto !== Object.prototype && proto !== null))
        {
            throw this.InvalidParams(new AdminEnumError(field))
        }
        const result = new Map<string, string>()
        for (const [key, entry] of Object.entries(value))
        {
            if (typeof entry !== 'string')
            {
                throw this.InvalidParams(new AdminEnumError(field))
            }
            result.set(key, entry)
        }
        return result
    }

    private RequirePrincipalId(value: unknown): string
    {
        return this.RequireNonEmptyString(value, ServerConnectionHandler.PrincipalIdField)
    }

    private RequireTokenRef(value: unknown): string
    {
        return this.RequireNonEmptyString(value, ServerConnectionHandler.TokenRefField)
    }

    private ParseCreateAccount(dto: CreateAccountParams): { email: string, principalId: string }
    {
        try
        {
            const email = this.RequireNonEmptyString(dto?.email, ServerConnectionHandler.EmailField)
            const principalId = this.RequireNonEmptyString(dto?.principalId, ServerConnectionHandler.PrincipalIdField)
            // password is validated at the call site (it must be wrapped and cleared there).
            return { email, principalId }
        }
        catch (error)
        {
            throw this.InvalidParams(error)
        }
    }

    private ParseIssueToken(dto: IssueTokenParams): { principalId: string, scopes: string[], expiresAt: Date | null }
    {
        try
        {
            const principalId = this.RequireNonEmptyString(dto?.principalId, ServerConnectionHandler.PrincipalIdField)
            const scopes = this.RequireStringArray(dto?.scopes, ServerConnectionHandler.ScopesField)
            const expiresAt = this.ParseExpiry(dto?.expiresInSeconds)
            return { principalId, scopes, expiresAt }
        }
        catch (error)
        {
            throw this.InvalidParams(error)
        }
    }

    private ParseExpiry(value: unknown): Date | null
    {
        if (value === null || value === undefined)
        {
            return null
        }
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
        {
            throw this.InvalidParams(new AdminEnumError(ServerConnectionHandler.ExpiresInField))
        }
        const expiresAt = new Date(Date.now() + value * 1000)
        if (Number.isNaN(expiresAt.getTime()))
        {
            throw this.InvalidParams(new AdminEnumError(ServerConnectionHandler.ExpiresInField))
        }
        return expiresAt
    }

    private MapCreateError(error: unknown): unknown
    {
        if (error instanceof ResponseError)
        {
            return error
        }
        if (error instanceof Error && (error.message === ServerConnectionHandler.EmailTakenMessage || error.message === ServerConnectionHandler.PrincipalTakenMessage))
        {
            // duplicate email/principal from the registrar: a bad request; the raw message is not echoed.
            return new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.AccountExistsMessage)
        }
        return error
    }

    private ToAccountDto(account: LocalAccount): AccountDto
    {
        return { principalId: account.PrincipalId, email: account.Email, disabled: account.Disabled }
    }

    private ToServiceTokenSummaryDto(summary: ServiceTokenSummary): ServiceTokenSummaryDto
    {
        return {
            tokenRef: summary.TokenRef,
            principalId: summary.PrincipalId,
            scopes: [...summary.Scopes],
            expiresAt: summary.ExpiresAt === null ? null : summary.ExpiresAt.toISOString(),
            revoked: summary.Revoked,
        }
    }

    private ToTokenIssuedDto(issued: { Grant: ServiceTokenGrant, Token: string }): TokenIssuedDto
    {
        return {
            tokenRef: issued.Grant.TokenRef,
            token: issued.Token,
            principalId: issued.Grant.PrincipalId,
            scopes: [...issued.Grant.Scopes],
            expiresAt: issued.Grant.ExpiresAt === null ? null : issued.Grant.ExpiresAt.toISOString(),
        }
    }

    private ToGrantDto(grant: Grant): GrantDto
    {
        return {
            subject: grant.Subject,
            role: AdminEnums.NameOfRole(grant.Role),
            resourceKind: AdminEnums.NameOfResourceKind(grant.Resource.Kind),
            resourcePath: [...grant.Resource.Path],
        }
    }

    private ToConfigDto(config: IdentityConfig): IdentityConfigDto
    {
        const groupRoleMap: Record<string, string> = {}
        for (const [group, role] of config.GroupRoleMap)
        {
            groupRoleMap[group] = AdminEnums.NameOfRole(role)
        }
        return {
            packId: config.PackId,
            delegationDepth: AdminEnums.NameOfDepth(config.DelegationDepth),
            providerSettings: Object.fromEntries(config.ProviderSettings),
            groupRoleMap,
            claimsMapping: Object.fromEntries(config.ClaimsMapping),
            // ISecurityModelConfig and SecurityModelDto are field-identical, JSON-safe shapes.
            securityModel: config.SecurityModel as SecurityModelDto | undefined,
        }
    }

    private ParseConfigDto(dto: IdentityConfigDto): IdentityConfig
    {
        try
        {
            const packId = this.RequireNonEmptyString(dto.packId, ServerConnectionHandler.PackIdField)
            const depth = AdminEnums.DepthFromName(dto.delegationDepth)
            const providerSettings = this.RequireStringRecord(dto.providerSettings, ServerConnectionHandler.ProviderSettingsField)
            const groupNames = this.RequireStringRecord(dto.groupRoleMap, ServerConnectionHandler.GroupRoleMapField)
            const claimsMapping = this.RequireStringRecord(dto.claimsMapping, ServerConnectionHandler.ClaimsMappingField)
            const groupRoles = new Map<string, Role>()
            for (const [group, name] of groupNames)
            {
                try
                {
                    groupRoles.set(group, AdminEnums.RoleFromName(name))
                }
                catch
                {
                    throw this.InvalidParams(new AdminEnumError(ServerConnectionHandler.GroupRoleMapField))
                }
            }
            let securityModel: ISecurityModelConfig | undefined
            if (dto.securityModel !== undefined)
            {
                const candidate = dto.securityModel as unknown as ISecurityModelConfig
                try
                {
                    AccessDepthEvaluator.FromConfig(candidate)
                }
                catch
                {
                    throw this.InvalidParams(new AdminEnumError(ServerConnectionHandler.SecurityModelField))
                }
                securityModel = candidate
            }
            return new IdentityConfig(packId, depth, providerSettings, groupRoles, claimsMapping, securityModel)
        }
        catch (error)
        {
            throw this.InvalidParams(error)
        }
    }

    /** Validates the incoming model via the evaluator (as ParseConfigDto does) and rejects a malformed one before any write. */
    private ParseSecurityModel(dto: SetSecurityModelParams): ISecurityModelConfig
    {
        // ISecurityModelConfig and SecurityModelDto are field-identical, JSON-safe shapes.
        const candidate = dto?.securityModel as unknown as ISecurityModelConfig
        try
        {
            AccessDepthEvaluator.FromConfig(candidate)
        }
        catch
        {
            throw this.InvalidParams(new AdminEnumError(ServerConnectionHandler.SecurityModelField))
        }
        return candidate
    }

    private async ResourceHidden(nodeId: string): Promise<boolean>
    {
        const solution = this.manager.ActiveSolution
        if (solution === undefined)
        {
            return false
        }
        for (const member of solution.Members.ToArray())
        {
            if (member.Storage === undefined)
            {
                continue
            }
            const view = await this.languageService.ModelView(member.Storage)
            if (view === undefined || view.model.resolve(nodeId) === undefined)
            {
                continue
            }
            return new ModelReadFilter(view.model, this.accessContext, AllowAllFieldReadMask.Instance).Hidden(nodeId)
        }
        return false
    }

    private async ProjectModelView(params: ModelViewParams): Promise<ModelViewPageDto>
    {
        const solution = this.manager.ActiveSolution
        if (solution === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.NoActiveSolutionError)
        }
        const memberId = params?.memberId
        const member = solution.Members.ToArray().find(m => m.Ref.path === memberId)
        if (member === undefined || member.Storage === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.UnknownMemberError)
        }
        PageRequest.ValidatePageSize(params)
        const view = await this.languageService.ModelView(member.Storage)
        if (view === undefined)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.UnknownMemberError)
        }
        // read the revision only once the view is in hand: acquiring it may itself commit the first build
        const fingerprint = PageFingerprint.Of(ServerConnectionHandler.ModelViewFingerprintTag, memberId, String(this.languageService.GraphRevision))
        const page = PageRequest.Resolve(params, fingerprint, this.paging)
        const mask = await this.fieldMasks.FieldReadMaskFor(this.accessContext)
        const members = new ModelReadFilter(view.model, this.accessContext, mask).Page(view.provenanceOf, page.Offset, page.Size)
        const nextCursor = page.NextCursor(members.HasMore)
        return nextCursor === undefined
            ? { items: members.Items, provenanceOf: members.ProvenanceOf }
            : { items: members.Items, provenanceOf: members.ProvenanceOf, nextCursor }
    }

    private RegisterSolutionHandlers(): void
    {
        this.guarded(SolutionProtocol.OpenSolution, async p =>
        {
            this.EnsureDevelopment()
            await this.manager.OpenSolution(p.location)
            await this.connectorService.Invalidate()
            return this.SummariseActiveSolution()
        })
        this.guardedNoParams(SolutionProtocol.ActiveSolution, () => this.ActiveSolutionOrNull())
    }

    private async PublishDiagnostics(uri: string, text: string): Promise<void>
    {
        try
        {
            this.languageService.DidChange(uri, text)
            const diagnostics = await this.languageService.DiagnosticsFor(uri)
            if (this.gate.CanRead())
            {
                await this.connection.sendNotification(LanguageProtocol.PublishDiagnostics, { uri, diagnostics })
            }
        }
        catch
        {
            // fail closed: a failed wire op pushes nothing and never escapes as an unhandled rejection
        }
    }

    private SummariseActiveSolution(): ActiveSolutionSummary
    {
        const summary = this.ActiveSolutionOrNull()
        if (summary === null)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, ServerConnectionHandler.NoActiveSolutionError)
        }
        return summary
    }

    private ActiveSolutionOrNull(): ActiveSolutionSummary | null
    {
        const solution = this.manager.ActiveSolution
        if (solution === undefined)
        {
            return null
        }
        return {
            name: solution.Name,
            members: solution.Members.ToArray().map(m => ({ id: m.Ref.path, type: m.Ref.type })),
            buildState: BuildStateMapper.ToWire(this.languageService.BuildState),
        }
    }
}
