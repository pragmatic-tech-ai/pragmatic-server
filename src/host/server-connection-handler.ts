import {
    createMessageConnection, NullLogger, WebSocketMessageReader, WebSocketMessageWriter, LanguageProtocol, SolutionProtocol, ModelProtocol,
} from '@pragmatic-tech-ai/pragmatic-protocol'
import type { MessageConnection, IMessageSocket, ActiveSolutionSummary, ModelProjection, ModelMemberDto, ResolvedResourceDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import type { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'

/** One client connection: wires every JSON-RPC handler 1:1 to the engine services and pushes notifications. */
export class ServerConnectionHandler
{
    private static readonly NoActiveSolutionError = 'no active solution after open'
    private static readonly UnknownMemberError = 'unknown solution member'

    private readonly connection: MessageConnection
    private readonly languageService: ILanguageService
    private readonly manager: SolutionManagerService
    private readonly accessContext: AccessContext
    private readonly graphSubscription: IDisposable

    private constructor(connection: MessageConnection, languageService: ILanguageService, manager: SolutionManagerService, accessContext: AccessContext)
    {
        this.accessContext = accessContext
        this.connection = connection
        this.languageService = languageService
        this.manager = manager
        this.RegisterLanguageHandlers()
        this.RegisterSolutionHandlers()
        this.RegisterModelHandlers()
        this.graphSubscription = languageService.GraphChanged.subscribe(async change =>
        {
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

    public static Attach(socket: IMessageSocket, languageService: ILanguageService, manager: SolutionManagerService, accessContext: AccessContext): ServerConnectionHandler
    {
        const connection = createMessageConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket), NullLogger)
        const handler = new ServerConnectionHandler(connection, languageService, manager, accessContext)
        connection.listen()
        return handler
    }

    public Dispose(): void
    {
        this.graphSubscription.dispose()
        this.connection.dispose()
    }

    private RegisterLanguageHandlers(): void
    {
        const connection = this.connection
        const service = this.languageService
        connection.onRequest(LanguageProtocol.CompletionsAt, p => service.CompletionsAt(p.uri, p.position))
        connection.onRequest(LanguageProtocol.HoverAt, p => service.HoverAt(p.uri, p.position))
        connection.onRequest(LanguageProtocol.DefinitionAt, p => service.DefinitionAt(p.uri, p.position))
        connection.onRequest(LanguageProtocol.ReferencesAt, p => service.ReferencesAt(p.uri, p.position, p.includeDeclaration))
        connection.onRequest(LanguageProtocol.PrepareRename, p => service.PrepareRename(p.uri, p.position))
        connection.onRequest(LanguageProtocol.RenameEdits, p => service.RenameEdits(p.uri, p.position, p.newName))
        connection.onRequest(LanguageProtocol.DocumentSymbols, p => service.DocumentSymbols(p.uri))
        connection.onRequest(LanguageProtocol.FoldingRanges, p => service.FoldingRanges(p.uri))
        connection.onRequest(LanguageProtocol.WorkspaceSymbols, p => service.WorkspaceSymbols(p.query))
        connection.onRequest(LanguageProtocol.SemanticTokens, p => service.SemanticTokens(p.uri))
        connection.onRequest(LanguageProtocol.SignatureHelpAt, p => service.SignatureHelpAt(p.uri, p.position))
        connection.onRequest(LanguageProtocol.CodeActions, p => service.CodeActions(p.uri, p.range, p.diagnostics as Parameters<ILanguageService['CodeActions']>[2]))
        connection.onRequest(LanguageProtocol.FormatDocument, p => service.FormatDocument(p.uri))
        connection.onRequest(LanguageProtocol.DiagnosticsFor, p => service.DiagnosticsFor(p.uri))
        connection.onNotification(LanguageProtocol.DidChange, p => void this.PublishDiagnostics(p.uri, p.text))
    }

    private RegisterModelHandlers(): void
    {
        const connection = this.connection
        connection.onRequest(ModelProtocol.ModelView, p => this.ProjectModelView(p.memberId))
        connection.onRequest(ModelProtocol.Resources, async p =>
        {
            const resources = await this.languageService.Resources(p.nodeId)
            const dtos: ResolvedResourceDto[] = resources.map(r => ({ annotation: r.annotation, path: r.path, storageRoot: r.storage.Root }))
            return dtos
        })
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
        const members: ModelMemberDto[] = view.model.allNodes().map(node => ({ id: node.id, kind: node.metaKind ?? node.type }))
        return { members, provenanceOf: Object.fromEntries(view.provenanceOf) }
    }

    private RegisterSolutionHandlers(): void
    {
        const connection = this.connection
        connection.onRequest(SolutionProtocol.OpenSolution, async p =>
        {
            await this.manager.OpenSolution(p.location)
            return this.SummariseActiveSolution()
        })
        connection.onRequest(SolutionProtocol.ActiveSolution, () => this.ActiveSolutionOrNull())
    }

    private async PublishDiagnostics(uri: string, text: string): Promise<void>
    {
        try
        {
            this.languageService.DidChange(uri, text)
            const diagnostics = await this.languageService.DiagnosticsFor(uri)
            await this.connection.sendNotification(LanguageProtocol.PublishDiagnostics, { uri, diagnostics })
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
