import { Action, ResourceKind, ResourceRef, AccessDecision, type AccessContext } from '@pragmatic-tech-ai/pragmatic-identity'
import { trace, isSpanContextValid } from '@opentelemetry/api'
import { NullAccessAuditSink, AuditSurface, AuditOutcome, type IAccessAuditSink, type AccessAuditEvent } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { LanguageProtocol, SolutionProtocol, ModelProtocol, ConnectorProtocol, AdminProtocol, CypherProtocol, PragmaticAppProtocol, ApplicationDeployProtocol, RunTestProtocol, AppDataProtocol, DataSharingProtocol, DataAssignmentProtocol, GraphProtocol, StorageProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'

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
    private readonly audit: IAccessAuditSink

    public constructor(context: AccessContext, path: () => readonly string[], audit: IAccessAuditSink = new NullAccessAuditSink())
    {
        this.context = context
        this.path = path
        this.audit = audit
    }

    public Authorize(method: string): AccessDecision
    {
        const policy = PolicyGate.Table.get(method)
        if (policy === undefined)
        {
            const denied = AccessDecision.Deny(PolicyGate.UntabledReason)
            this.Emit(method, undefined, undefined, denied, [])
            return denied
        }
        const path = this.path()
        const resource = new ResourceRef(policy.resourceKind, this.context.Realm.Id, path)
        const decision = this.context.Policy.Decide(this.context, policy.action, resource)
        this.Emit(method, policy.action, policy.resourceKind, decision, path)
        return decision
    }

    /** `Authorize`'s decision for `method` without an audit event (a server push re-checks it per send). */
    public Permits(method: string): boolean
    {
        const policy = PolicyGate.Table.get(method)
        if (policy === undefined)
        {
            return false
        }
        const resource = new ResourceRef(policy.resourceKind, this.context.Realm.Id, this.path())
        return this.context.Policy.Decide(this.context, policy.action, resource).Allowed
    }

    public CanRead(): boolean
    {
        const resource = new ResourceRef(ResourceKind.Model, this.context.Realm.Id, this.path())
        return this.context.Policy.Decide(this.context, Action.Read, resource).Allowed
    }

    private Emit(method: string, action: Action | undefined, resourceKind: ResourceKind | undefined, decision: AccessDecision, path: readonly string[]): void
    {
        try
        {
            const spanContext = trace.getActiveSpan()?.spanContext()
            const event: AccessAuditEvent = {
                Timestamp: new Date(),
                EnvironmentId: this.context.Realm.Id,
                PrincipalId: this.context.Principal.Id,
                Surface: AuditSurface.Rpc,
                MethodOrPath: method,
                Action: action,
                ResourceKind: resourceKind,
                ResourcePath: path.length > 0 ? path.join('/') : undefined,
                Outcome: decision.Allowed ? AuditOutcome.Allow : AuditOutcome.Deny,
                Reason: decision.Reason,
                CorrelationId: spanContext !== undefined && isSpanContextValid(spanContext) ? spanContext.traceId : undefined,
            }
            void this.audit.Record(event).catch(() => {})
        }
        catch
        {
            // audit is fire-and-forget: a sink that throws must never alter the decision this method returns
        }
    }

    private static BuildTable(): ReadonlyMap<string, MethodPolicy>
    {
        const read: MethodPolicy = { action: Action.Read, resourceKind: ResourceKind.Model }
        const write: MethodPolicy = { action: Action.Write, resourceKind: ResourceKind.Model }
        const administer: MethodPolicy = { action: Action.Administer, resourceKind: ResourceKind.Realm }
        const readRealm: MethodPolicy = { action: Action.Read, resourceKind: ResourceKind.Realm }
        const writeRealm: MethodPolicy = { action: Action.Write, resourceKind: ResourceKind.Realm }
        const contribute: MethodPolicy = { action: Action.Contribute, resourceKind: ResourceKind.Realm }
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
            [SolutionProtocol.ActiveSolution.method, readRealm],
            [SolutionProtocol.ListSolutions.method, readRealm],
            [SolutionProtocol.SelectAuthoring.method, writeRealm],
            [SolutionProtocol.CreateSolution.method, writeRealm],
            [StorageProtocol.ReadText.method, readRealm],
            [StorageProtocol.ReadBytes.method, readRealm],
            [StorageProtocol.Exists.method, readRealm],
            [StorageProtocol.List.method, readRealm],
            [StorageProtocol.WriteText.method, writeRealm],
            [StorageProtocol.WriteBytes.method, writeRealm],
            [StorageProtocol.Delete.method, writeRealm],
            [StorageProtocol.CreateDirectory.method, writeRealm],
            [StorageProtocol.Rename.method, writeRealm],
            [ModelProtocol.ModelView.method, read],
            [ModelProtocol.Resources.method, read],
            [ConnectorProtocol.List.method, readConnector],
            [ConnectorProtocol.Read.method, readConnector],
            [ConnectorProtocol.Decisions.method, readConnector],
            [ConnectorProtocol.ReadPage.method, readConnector],
            [ConnectorProtocol.WriteBack.method, writeConnector],
            [ConnectorProtocol.WritePaged.method, writeConnector],
            [ConnectorProtocol.Test.method, connect],
            [ConnectorProtocol.Prepare.method, connect],
            [ConnectorProtocol.Refresh.method, connect],
            [ConnectorProtocol.RefreshModel.method, connect],
            [CypherProtocol.Query.method, readRealm],
            [CypherProtocol.Execute.method, writeRealm],
            [CypherProtocol.Models.method, readRealm],
            [AppDataProtocol.Write.method, writeRealm],
            [DataSharingProtocol.Share.method, writeRealm],
            [DataSharingProtocol.Unshare.method, writeRealm],
            [DataSharingProtocol.ListShares.method, readRealm],
            [DataAssignmentProtocol.Assign.method, writeRealm],
            [PragmaticAppProtocol.List.method, readRealm],
            [PragmaticAppProtocol.Open.method, readRealm],
            [ApplicationDeployProtocol.Deploy.method, administer],
            [RunTestProtocol.Load.method, writeRealm],
            [GraphProtocol.Create.method, administer],
            [GraphProtocol.Delete.method, administer],
            [GraphProtocol.List.method, readRealm],
            [GraphProtocol.Get.method, readRealm],
            [GraphProtocol.Export.method, readRealm],
            [GraphProtocol.Contribute.method, contribute],
            [GraphProtocol.Load.method, administer],
            [GraphProtocol.Loaded.method, readRealm],
            [AdminProtocol.ListGrants.method, administer],
            [AdminProtocol.GrantRole.method, administer],
            [AdminProtocol.RevokeRole.method, administer],
            [AdminProtocol.GetConfig.method, administer],
            [AdminProtocol.SetConfig.method, administer],
            [AdminProtocol.GetSecurityModel.method, administer],
            [AdminProtocol.SetSecurityModel.method, administer],
            [AdminProtocol.GetSecurityCatalog.method, administer],
            [AdminProtocol.ListTeamMembers.method, administer],
            [AdminProtocol.ListSecurityChanges.method, administer],
            [AdminProtocol.ListAccounts.method, administer],
            [AdminProtocol.CreateAccount.method, administer],
            [AdminProtocol.DisableAccount.method, administer],
            [AdminProtocol.ListTokens.method, administer],
            [AdminProtocol.IssueToken.method, administer],
            [AdminProtocol.RevokeToken.method, administer],
            [AdminProtocol.InvalidatePack.method, administer],
            [AdminProtocol.ListScriptAllowlist.method, administer],
            [AdminProtocol.AllowPackScripts.method, administer],
            [AdminProtocol.DenyPackScripts.method, administer],
        ])
    }
}
