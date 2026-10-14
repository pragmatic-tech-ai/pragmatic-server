import {
    createMessageConnection, NullLogger, WebSocketMessageReader, WebSocketMessageWriter, LanguageProtocol, SolutionProtocol, ModelProtocol, ConnectorProtocol, AdminProtocol,
} from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection, IMessageSocket, ActiveSolutionSummary, ModelProjection, ResolvedResourceDto, GrantDto, GrantMutationDto, IdentityConfigDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { RequestType, NotificationType } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ResourceRef, IdentityConfig } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, Grant, Role } from '@pragmatic-tech-ai/todl-identity'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PolicyGate } from './policy-gate.js'
import { AuditSurface } from './access-audit.js'
import type { IAccessAuditSink } from './access-audit.js'
import { RateLimitGuard } from './rate-limit-guard.js'
import { RateLimitScope } from './rate-limiter.js'
import { ConnectorService } from './connector-service.js'
import type { ConnectorRuntime } from '../connectors/connector-runtime.js'
import { ModelReadFilter } from './model-read-filter.js'
import { AdminService, AdminSelfLockoutError, AdminConfigMissingError } from './admin-service.js'
import { AdminEnums, AdminEnumError } from './admin-enums.js'
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
    private static readonly InvalidParamsPrefix = 'invalid params: '
    public static readonly RateLimitedCode = -32029

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

    private constructor(connection: MessageConnection, languageService: ILanguageService, manager: SolutionManagerService, accessContext: AccessContext, connectorsFactory: () => Promise<ConnectorRuntime>, instrumentation?: RequestInstrumentation, parent?: Context, audit?: IAccessAuditSink, rateLimit?: RateLimitGuard, admin?: AdminService)
    {
        this.rateLimit = rateLimit
        this.admin = admin
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

    public static Attach(socket: IMessageSocket, languageService: ILanguageService, manager: SolutionManagerService, accessContext: AccessContext, connectorsFactory: () => Promise<ConnectorRuntime>, instrumentation?: RequestInstrumentation, parent?: Context, audit?: IAccessAuditSink, rateLimit?: RateLimitGuard, admin?: AdminService): ServerConnectionHandler
    {
        const connection = createMessageConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket), NullLogger)
        const handler = new ServerConnectionHandler(connection, languageService, manager, accessContext, connectorsFactory, instrumentation, parent, audit, rateLimit, admin)
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
    {
        this.connection.onRequest(type, () => this.Dispatch(type.method, () =>
        {
            this.EnforceRate(type.method)
            this.authorize(type.method)
            return handler()
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

    private RegisterAdminHandlers(): void
    {
        const admin = this.admin as AdminService
        this.guarded(AdminProtocol.ListGrants, async p => (await this.AdminCall(() => admin.ListGrants(p.subject))).map(g => this.ToGrantDto(g)))
        this.guarded(AdminProtocol.GrantRole, async p =>
        {
            const { role, resource } = this.ParseMutation(p)
            await this.AdminCall(() => admin.GrantRole(this.actor(), p.subject, role, resource))
            return { ok: true as const }
        })
        this.guarded(AdminProtocol.RevokeRole, async p =>
        {
            const { role, resource } = this.ParseMutation(p)
            await this.AdminCall(() => admin.RevokeRole(this.actor(), p.subject, role, resource))
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
            if (error instanceof AdminSelfLockoutError || error instanceof AdminConfigMissingError)
            {
                throw new ResponseError(ErrorCodes.InvalidRequest, error.message)
            }
            throw error
        }
    }

    private InvalidParams(error: unknown): ResponseError<void>
    {
        const field = error instanceof AdminEnumError ? error.Field : ServerConnectionHandler.InvalidConfigField
        return new ResponseError(ErrorCodes.InvalidParams, `${ServerConnectionHandler.InvalidParamsPrefix}${field}`)
    }

    private ParseMutation(dto: GrantMutationDto): { role: Role, resource: ResourceRef }
    {
        try
        {
            const role = AdminEnums.RoleFromName(dto.role)
            const kind = AdminEnums.ResourceKindFromName(dto.resourceKind ?? ServerConnectionHandler.DefaultResourceKind)
            const path = Array.isArray(dto.resourcePath) ? dto.resourcePath : []
            return { role, resource: new ResourceRef(kind, this.accessContext.Tenant.Id, path) }
        }
        catch (error)
        {
            throw this.InvalidParams(error)
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
            if (typeof dto.packId !== 'string' || dto.packId.length === 0)
            {
                throw new AdminEnumError('packId')
            }
            const depth = AdminEnums.DepthFromName(dto.delegationDepth)
            const groupRoles = new Map<string, Role>()
            for (const [group, name] of Object.entries(dto.groupRoleMap ?? {}))
            {
                groupRoles.set(group, AdminEnums.RoleFromName(name))
            }
            return new IdentityConfig(dto.packId, depth, new Map(Object.entries(dto.providerSettings ?? {})), groupRoles, new Map(Object.entries(dto.claimsMapping ?? {})))
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
