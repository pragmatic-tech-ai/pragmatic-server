import {
    createMessageConnection, NullLogger, WebSocketMessageReader, WebSocketMessageWriter, LanguageProtocol, SolutionProtocol, ModelProtocol, ConnectorProtocol, AdminProtocol, CypherProtocol, PragmaticAppProtocol,
} from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection, IMessageSocket, ActiveSolutionSummary, ModelProjection, ResolvedResourceDto, GrantDto, GrantMutationDto, IdentityConfigDto, AccountDto, CreateAccountParams, ServiceTokenSummaryDto, IssueTokenParams, TokenIssuedDto, CypherQueryParams, CypherQueryResultDto, PragmaticAppSummaryDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { RequestType, NotificationType } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ResourceRef, IdentityConfig, PresentedSecret, LocalAccountNotFoundError } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, Grant, Role, LocalAccount, ServiceTokenSummary, ServiceTokenGrant } from '@pragmatic-tech-ai/todl-identity'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { Cypher } from '@pragmatic-tech-ai/todl'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import type { ReferencedLabelSet } from '../pragmatic-server.js'
import { PolicyGate } from './policy-gate.js'
import { AuditSurface } from './access-audit.js'
import type { IAccessAuditSink } from './access-audit.js'
import { RateLimitGuard } from './rate-limit-guard.js'
import { RateLimitScope } from './rate-limiter.js'
import { ConnectorService } from './connector-service.js'
import type { ConnectorRuntime } from '../connectors/connector-runtime.js'
import { ModelReadFilter } from './model-read-filter.js'
import { AdminService, AdminSelfLockoutError, LastAdministratorError, AdminConfigMissingError, AdminTokenNotFoundError } from './admin-service.js'
import { AdminEnums, AdminEnumError } from './admin-enums.js'
import { TenantPurpose } from '../tenancy/tenant-purpose.js'
import type { PragmaticAppsRegistry } from './apps/pragmatic-apps-registry.js'
import { CypherLimits } from '../config/cypher-limits.js'
import { CypherParamConverter, CypherParamError } from './cypher/cypher-param-converter.js'
import { CypherResultMapper } from './cypher/cypher-result-mapper.js'
import { trace } from '@opentelemetry/api'
import type { Context } from '@opentelemetry/api'
import type { RequestInstrumentation } from '../observability/request-instrumentation.js'

/** One client connection: wires every JSON-RPC handler 1:1 to the engine services and pushes notifications. */
export class ServerConnectionHandler
{
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
    private static readonly PrincipalIdField = 'principalId'
    private static readonly EmailField = 'email'
    private static readonly PasswordField = 'password'
    private static readonly TokenRefField = 'tokenRef'
    private static readonly ScopesField = 'scopes'
    private static readonly ExpiresInField = 'expiresInSeconds'
    private static readonly EmailTakenMessage = 'email already registered'
    private static readonly PrincipalTakenMessage = 'principal already registered'
    private static readonly AccountExistsMessage = 'account already exists'
    private static readonly InvalidParamsPrefix = 'invalid params: '
    private static readonly CypherField = 'cypher'
    private static readonly CypherTimeoutMessage = 'cypher query timed out'
    private static readonly NotRuntimeMessage = 'operation requires a runtime tenant'
    private static readonly NotDevelopmentMessage = 'operation requires a development tenant'
    private static readonly NameMismatchMessage = 'application manifest name does not match requested name: '
    private static readonly NoApplicationSelectedMessage = 'no application selected: call application/open first'
    private static readonly ApplicationsUnavailableMessage = 'pragmatic applications are not available on this connection'
    public static readonly RateLimitedCode = -32029
    public static readonly CypherTimeoutCode = -32030

    private readonly connection: MessageConnection
    private readonly languageService: ILanguageService
    private readonly manager: SolutionManagerService
    private readonly accessContext: AccessContext
    private readonly gate: PolicyGate
    private readonly connectorService: ConnectorService
    private readonly graphSubscription: IDisposable
    private readonly instrumentation: RequestInstrumentation | undefined
    private readonly parent: Context | undefined
    private readonly rateLimit: RateLimitGuard | undefined
    private readonly admin: AdminService | undefined
    private readonly graphProvider: (context: AccessContext) => Promise<IGraphQuery>
    private readonly cypherLimits: CypherLimits
    private readonly purpose: TenantPurpose
    private readonly applications: PragmaticAppsRegistry | undefined
    private readonly appGraphProvider: ((context: AccessContext, name: string, labels: ReferencedLabelSet) => Promise<IGraphQuery>) | undefined
    private boundApp: PragmaticAppSummaryDto | undefined

    private constructor(connection: MessageConnection, languageService: ILanguageService, manager: SolutionManagerService, accessContext: AccessContext, connectorsFactory: () => Promise<ConnectorRuntime>, graphProvider: (context: AccessContext) => Promise<IGraphQuery>, instrumentation?: RequestInstrumentation, parent?: Context, audit?: IAccessAuditSink, rateLimit?: RateLimitGuard, admin?: AdminService, cypherLimits?: CypherLimits, purpose: TenantPurpose = TenantPurpose.Development, applications?: PragmaticAppsRegistry, appGraphProvider?: (context: AccessContext, name: string, labels: ReferencedLabelSet) => Promise<IGraphQuery>)
    {
        this.cypherLimits = cypherLimits ?? new CypherLimits()
        this.purpose = purpose
        this.applications = applications
        this.appGraphProvider = appGraphProvider
        this.rateLimit = rateLimit
        this.admin = admin
        this.graphProvider = graphProvider
        this.instrumentation = instrumentation
        this.parent = parent
        this.connectorService = new ConnectorService(connectorsFactory)
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
    }

    /** The runtime-only Attach arguments (application registry + per-app graph provider); both undefined unless the server is a Runtime tenant. */
    public static RuntimeAttachArgs(server: { Purpose(): TenantPurpose; Applications(): PragmaticAppsRegistry; GraphForPragmaticApp(context: AccessContext, name: string, labels: ReferencedLabelSet): Promise<IGraphQuery> }): { applications: PragmaticAppsRegistry | undefined; appGraphProvider: ((context: AccessContext, name: string, labels: ReferencedLabelSet) => Promise<IGraphQuery>) | undefined }
    {
        if (server.Purpose() !== TenantPurpose.Runtime)
        {
            return { applications: undefined, appGraphProvider: undefined }
        }
        return { applications: server.Applications(), appGraphProvider: (context, name, labels) => server.GraphForPragmaticApp(context, name, labels) }
    }

    public static Attach(socket: IMessageSocket, languageService: ILanguageService, manager: SolutionManagerService, accessContext: AccessContext, connectorsFactory: () => Promise<ConnectorRuntime>, graphProvider: (context: AccessContext) => Promise<IGraphQuery>, instrumentation?: RequestInstrumentation, parent?: Context, audit?: IAccessAuditSink, rateLimit?: RateLimitGuard, admin?: AdminService, cypherLimits?: CypherLimits, purpose: TenantPurpose = TenantPurpose.Development, applications?: PragmaticAppsRegistry, appGraphProvider?: (context: AccessContext, name: string, labels: ReferencedLabelSet) => Promise<IGraphQuery>): ServerConnectionHandler
    {
        const connection = createMessageConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket), NullLogger)
        const handler = new ServerConnectionHandler(connection, languageService, manager, accessContext, connectorsFactory, graphProvider, instrumentation, parent, audit, rateLimit, admin, cypherLimits, purpose, applications, appGraphProvider)
        connection.listen()
        return handler
    }

    public Dispose(): void
    {
        this.graphSubscription.dispose()
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
        if (this.instrumentation === undefined)
        {
            return operation()
        }
        return this.instrumentation.Run({ method, tenant: this.accessContext.Tenant.Id, principal: this.accessContext.Principal.Id }, operation, this.parent)
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
    private guardedNoParams(type: typeof SolutionProtocol.ActiveSolution | typeof PragmaticAppProtocol.List, handler: () => unknown): void
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
        this.guarded(ModelProtocol.ModelView, p => this.ProjectModelView(p.memberId))
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
        this.connection.onRequest(ConnectorProtocol.Refresh, () => this.Dispatch(ConnectorProtocol.Refresh.method, () =>
        {
            this.EnforceRate(ConnectorProtocol.Refresh.method)
            this.authorize(ConnectorProtocol.Refresh.method)
            this.connectorService.Invalidate()
        }))
        this.guarded(ConnectorProtocol.Prepare, p => this.connectorService.Prepare(p.modelId))
        this.guarded(ConnectorProtocol.Read, p => this.connectorService.Read(p.modelId, p.concept))
        this.guarded(ConnectorProtocol.WriteBack, p => this.connectorService.WriteBack(p))
        this.guarded(ConnectorProtocol.Test, p => this.connectorService.Test(p.modelId, p.connectorName))
    }

    private RegisterCypherHandlers(): void
    {
        this.guarded(CypherProtocol.Query, p => this.RunCypherQuery(p))
    }

    public async RunCypherQuery(params: CypherQueryParams): Promise<CypherQueryResultDto>
    {
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
                throw new ResponseError(ErrorCodes.InvalidParams, `${ServerConnectionHandler.InvalidParamsPrefix}${error.message}`)
            }
            throw error
        }
        const graph = this.purpose === TenantPurpose.Runtime
            ? await this.RequireBoundAppGraph(Cypher.ReferencedLabels.Of(source))
            : await this.graphProvider(this.accessContext)
        try
        {
            const engine = Cypher.CypherEngine.OverQuery(graph, { MaxVarLength: this.cypherLimits.MaxVarLength })
            const result = engine.Execute(source, parameters, { RowCap: this.cypherLimits.RowCap, Cancel: Cypher.Deadline.After(this.cypherLimits.TimeoutMs) })
            return CypherResultMapper.ToWire(Cypher.CypherEngine.ToDto(result))
        }
        catch (error)
        {
            if (error instanceof Cypher.CypherSyntaxError || error instanceof Cypher.CypherSemanticError)
            {
                throw new ResponseError(ErrorCodes.InvalidParams, `${ServerConnectionHandler.InvalidParamsPrefix}${error.message}`)
            }
            if (error instanceof Cypher.CypherTimeout)
            {
                throw new ResponseError(ServerConnectionHandler.CypherTimeoutCode, ServerConnectionHandler.CypherTimeoutMessage)
            }
            throw error
        }
    }

    private RegisterApplicationHandlers(): void
    {
        this.guardedNoParams(PragmaticAppProtocol.List, async () =>
        {
            this.EnsureRuntime()
            const summaries = await this.RequireApplications().List()
            return summaries.map(a => ({ name: a.name, version: a.version }))
        })
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
            if (error instanceof AdminSelfLockoutError || error instanceof LastAdministratorError || error instanceof AdminConfigMissingError || error instanceof LocalAccountNotFoundError || error instanceof AdminTokenNotFoundError)
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
        return new ResponseError(ErrorCodes.InvalidParams, `${ServerConnectionHandler.InvalidParamsPrefix}${field}`)
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
            return new IdentityConfig(packId, depth, providerSettings, groupRoles, claimsMapping)
        }
        catch (error)
        {
            throw this.InvalidParams(error)
        }
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
            return new ModelReadFilter(view.model, this.accessContext).Hidden(nodeId)
        }
        return false
    }

    private async ProjectModelView(memberId: string): Promise<ModelProjection>
    {
        const solution = this.manager.ActiveSolution
        if (solution === undefined)
        {
            throw new Error(ServerConnectionHandler.NoActiveSolutionError)
        }
        const member = solution.Members.ToArray().find(m => m.Ref.path === memberId)
        if (member === undefined || member.Storage === undefined)
        {
            throw new Error(ServerConnectionHandler.UnknownMemberError)
        }
        const view = await this.languageService.ModelView(member.Storage)
        if (view === undefined)
        {
            throw new Error(ServerConnectionHandler.UnknownMemberError)
        }
        return new ModelReadFilter(view.model, this.accessContext).Project(view.provenanceOf)
    }

    private RegisterSolutionHandlers(): void
    {
        this.guarded(SolutionProtocol.OpenSolution, async p =>
        {
            this.EnsureDevelopment()
            await this.manager.OpenSolution(p.location)
            this.connectorService.Invalidate()
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
            throw new Error(ServerConnectionHandler.NoActiveSolutionError)
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
        }
    }
}
