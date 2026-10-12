import {
    createMessageConnection, NullLogger, WebSocketMessageReader, WebSocketMessageWriter, LanguageProtocol, SolutionProtocol, ModelProtocol, ConnectorProtocol,
} from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection, IMessageSocket, ActiveSolutionSummary, ModelProjection, ResolvedResourceDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { ResponseError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { RequestType, NotificationType } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PolicyGate } from './policy-gate.js'
import { ConnectorService } from './connector-service.js'
import type { ConnectorRuntime } from '../connectors/connector-runtime.js'
import { ModelReadFilter } from './model-read-filter.js'

/** One client connection: wires every JSON-RPC handler 1:1 to the engine services and pushes notifications. */
export class ServerConnectionHandler
{
    private static readonly NoActiveSolutionError = 'no active solution after open'
    private static readonly UnknownMemberError = 'unknown solution member'

    private readonly connection: MessageConnection
    private readonly languageService: ILanguageService
    private readonly manager: SolutionManagerService
    private readonly accessContext: AccessContext
    private readonly gate: PolicyGate
    private readonly connectorService: ConnectorService
    private readonly graphSubscription: IDisposable

    private constructor(connection: MessageConnection, languageService: ILanguageService, manager: SolutionManagerService, accessContext: AccessContext, connectorsFactory: () => Promise<ConnectorRuntime>)
    {
        this.connectorService = new ConnectorService(connectorsFactory)
        this.accessContext = accessContext
        this.connection = connection
        this.languageService = languageService
        this.manager = manager
        this.gate = new PolicyGate(accessContext, () =>
        {
            const solution = manager.ActiveSolution
            return solution === undefined ? [] : [solution.Name]
        })
        this.RegisterLanguageHandlers()
        this.RegisterSolutionHandlers()
        this.RegisterModelHandlers()
        this.RegisterConnectorHandlers()
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

    public static Attach(socket: IMessageSocket, languageService: ILanguageService, manager: SolutionManagerService, accessContext: AccessContext, connectorsFactory: () => Promise<ConnectorRuntime>): ServerConnectionHandler
    {
        const connection = createMessageConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket), NullLogger)
        const handler = new ServerConnectionHandler(connection, languageService, manager, accessContext, connectorsFactory)
        connection.listen()
        return handler
    }

    public Dispose(): void
    {
        this.graphSubscription.dispose()
        this.connection.dispose()
    }

    private authorize(method: string): void
    {
        const decision = this.gate.Authorize(method)
        if (!decision.Allowed)
        {
            throw new ResponseError(ErrorCodes.InvalidRequest, decision.Reason)
        }
    }

    private guarded<P, R, E>(type: RequestType<P, R, E>, handler: (params: P) => R | Promise<R>): void
    {
        this.connection.onRequest(type, (params: P) =>
        {
            this.authorize(type.method)
            return handler(params)
        })
    }

    private guardedNoParams(type: typeof SolutionProtocol.ActiveSolution, handler: () => ActiveSolutionSummary | null): void
    {
        this.connection.onRequest(type, () =>
        {
            this.authorize(type.method)
            return handler()
        })
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
        this.connection.onRequest(ConnectorProtocol.List, () =>
        {
            this.authorize(ConnectorProtocol.List.method)
            return this.connectorService.List()
        })
        this.connection.onRequest(ConnectorProtocol.Refresh, () =>
        {
            this.authorize(ConnectorProtocol.Refresh.method)
            this.connectorService.Invalidate()
        })
        this.guarded(ConnectorProtocol.Prepare, p => this.connectorService.Prepare(p.modelId))
        this.guarded(ConnectorProtocol.Read, p => this.connectorService.Read(p.modelId, p.concept))
        this.guarded(ConnectorProtocol.WriteBack, p => this.connectorService.WriteBack(p))
        this.guarded(ConnectorProtocol.Test, p => this.connectorService.Test(p.modelId, p.connectorName))
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
