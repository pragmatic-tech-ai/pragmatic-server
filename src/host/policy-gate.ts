import { Action, ResourceKind, ResourceRef, AccessDecision } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { LanguageProtocol, SolutionProtocol, ModelProtocol, ConnectorProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'

interface MethodPolicy
{
    readonly action: Action
    readonly resourceKind: ResourceKind
}

/** Deny-by-default dispatch gate: classifies every client-initiated method as (Action, ResourceKind)
 *  and asks the connection's policy to Decide. A method absent from the table is denied. */
export class PolicyGate
{
    private static readonly UntabledReason = 'method is not authorized'

    private static readonly Table: ReadonlyMap<string, MethodPolicy> = PolicyGate.BuildTable()

    private readonly context: AccessContext
    private readonly path: () => readonly string[]

    public constructor(context: AccessContext, path: () => readonly string[])
    {
        this.context = context
        this.path = path
    }

    public Authorize(method: string): AccessDecision
    {
        const policy = PolicyGate.Table.get(method)
        if (policy === undefined)
        {
            return AccessDecision.Deny(PolicyGate.UntabledReason)
        }
        const resource = new ResourceRef(policy.resourceKind, this.context.Tenant.Id, this.path())
        return this.context.Policy.Decide(this.context, policy.action, resource)
    }

    public CanRead(): boolean
    {
        const resource = new ResourceRef(ResourceKind.Model, this.context.Tenant.Id, this.path())
        return this.context.Policy.Decide(this.context, Action.Read, resource).Allowed
    }

    private static BuildTable(): ReadonlyMap<string, MethodPolicy>
    {
        const read: MethodPolicy = { action: Action.Read, resourceKind: ResourceKind.Model }
        const write: MethodPolicy = { action: Action.Write, resourceKind: ResourceKind.Model }
        const administer: MethodPolicy = { action: Action.Administer, resourceKind: ResourceKind.Tenant }
        const readTenant: MethodPolicy = { action: Action.Read, resourceKind: ResourceKind.Tenant }
        const connect: MethodPolicy = { action: Action.Connect, resourceKind: ResourceKind.Connector }
        const readConnector: MethodPolicy = { action: Action.Read, resourceKind: ResourceKind.Connector }
        const writeConnector: MethodPolicy = { action: Action.Write, resourceKind: ResourceKind.Connector }
        return new Map<string, MethodPolicy>([
            [LanguageProtocol.CompletionsAt.method, read],
            [LanguageProtocol.HoverAt.method, read],
            [LanguageProtocol.DefinitionAt.method, read],
            [LanguageProtocol.ReferencesAt.method, read],
            [LanguageProtocol.PrepareRename.method, read],
            [LanguageProtocol.RenameEdits.method, read],
            [LanguageProtocol.DocumentSymbols.method, read],
            [LanguageProtocol.FoldingRanges.method, read],
            [LanguageProtocol.WorkspaceSymbols.method, read],
            [LanguageProtocol.SemanticTokens.method, read],
            [LanguageProtocol.SignatureHelpAt.method, read],
            [LanguageProtocol.CodeActions.method, read],
            [LanguageProtocol.FormatDocument.method, read],
            [LanguageProtocol.DiagnosticsFor.method, read],
            [LanguageProtocol.DidChange.method, write],
            [SolutionProtocol.OpenSolution.method, administer],
            [SolutionProtocol.ActiveSolution.method, readTenant],
            [ModelProtocol.ModelView.method, read],
            [ModelProtocol.Resources.method, read],
            [ConnectorProtocol.List.method, readConnector],
            [ConnectorProtocol.Read.method, readConnector],
            [ConnectorProtocol.WriteBack.method, writeConnector],
            [ConnectorProtocol.Test.method, connect],
            [ConnectorProtocol.Prepare.method, connect],
            [ConnectorProtocol.Refresh.method, connect],
        ])
    }
}
