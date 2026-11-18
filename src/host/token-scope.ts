import { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { ApplicationDeployProtocol, GraphProtocol, LanguageProtocol, PragmaticAppProtocol, RunTestProtocol, SolutionProtocol, StorageProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'

/** Scopes a service token may carry that restrict which methods it can call. */
export enum TokenScope
{
    GraphContribute = 'graph-contribute',
    ApplicationDeploy = 'application-deploy',
    Inspect = 'environment-inspect',
    Develop = 'environment-develop',
    RunTest = 'environment-run-test',
}

/** An AccessContext built from a service-token authentication, carrying that token's scopes explicitly.
 *  Session-authenticated contexts are never wrapped, so a session principal's groups are never read as scopes.
 *  WARNING: the handler detects scopes by instanceof; rebuilding or cloning the AccessContext on its way to
 *  ServerConnectionHandler.Attach drops them and FAILS OPEN. Pass this instance through unchanged. */
export class ScopedAccessContext extends AccessContext
{
    public readonly Scopes: readonly string[]

    public constructor(base: AccessContext, scopes: readonly string[])
    {
        super(base.Principal, base.Realm, base.Grants, base.Policy)
        this.Scopes = scopes
    }
}

/**
 * The request methods a develop credential may call: list and select solutions, read and write source, drive the language
 * service, and list and contribute graphs. Deliberately excludes graph create/delete/load, application/*, data/*, solution/open
 * (administer-gated) and admin/*. Shared with the desktop relay's develop allowlist so the two cannot drift.
 */
export class DevelopMethods
{
    public static readonly All: readonly string[] = [
        SolutionProtocol.ListSolutions.method,
        SolutionProtocol.SelectAuthoring.method,
        SolutionProtocol.CreateSolution.method,
        SolutionProtocol.ActiveSolution.method,
        StorageProtocol.ReadText.method,
        StorageProtocol.ReadBytes.method,
        StorageProtocol.WriteText.method,
        StorageProtocol.WriteBytes.method,
        StorageProtocol.Exists.method,
        StorageProtocol.Delete.method,
        StorageProtocol.CreateDirectory.method,
        StorageProtocol.Rename.method,
        StorageProtocol.List.method,
        LanguageProtocol.CompletionsAt.method,
        LanguageProtocol.HoverAt.method,
        LanguageProtocol.DefinitionAt.method,
        LanguageProtocol.ReferencesAt.method,
        LanguageProtocol.PrepareRename.method,
        LanguageProtocol.RenameEdits.method,
        LanguageProtocol.DocumentSymbols.method,
        LanguageProtocol.FoldingRanges.method,
        LanguageProtocol.WorkspaceSymbols.method,
        LanguageProtocol.SemanticTokens.method,
        LanguageProtocol.SignatureHelpAt.method,
        LanguageProtocol.CodeActions.method,
        LanguageProtocol.FormatDocument.method,
        LanguageProtocol.DiagnosticsFor.method,
        GraphProtocol.List.method,
        GraphProtocol.Contribute.method,
    ]
}

/**
 * The request methods a run/test credential may call: load a build into the run/test runtime, list the loaded applications,
 * and read the loaded graph. Strictly narrower than application/deploy (administer-gated) and the develop allowlist: no data,
 * shares, assignment, application/open or graph create/delete. Shared with the desktop relay's run/test allowlist so the two
 * cannot drift.
 */
export class RunTestMethods
{
    public static readonly All: readonly string[] = [
        RunTestProtocol.Load.method,
        PragmaticAppProtocol.List.method,
        GraphProtocol.Loaded.method,
    ]
}

/** Restricts the methods a credential may call by its known scopes. With no known scope the gate allows everything. */
export class TokenScopeGate
{
    private static readonly MethodsByScope: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
        [TokenScope.GraphContribute, [GraphProtocol.Contribute.method, GraphProtocol.List.method]],
        [TokenScope.ApplicationDeploy, [ApplicationDeployProtocol.Deploy.method]],
        [TokenScope.Inspect, [PragmaticAppProtocol.List.method, GraphProtocol.List.method, GraphProtocol.Loaded.method]],
        [TokenScope.Develop, DevelopMethods.All],
        [TokenScope.RunTest, RunTestMethods.All],
    ])

    private readonly allowed: ReadonlySet<string> | null

    private constructor(allowed: ReadonlySet<string> | null)
    {
        this.allowed = allowed
    }

    public static For(scopes: readonly string[]): TokenScopeGate
    {
        const allowed = new Set<string>()
        let known = false
        for (const scope of scopes)
        {
            const methods = TokenScopeGate.MethodsByScope.get(scope)
            if (methods !== undefined)
            {
                known = true
                methods.forEach(method => allowed.add(method))
            }
        }
        return new TokenScopeGate(known ? allowed : null)
    }

    /** The gate for a connection's context: scoped only when it came from a service token. */
    public static ForContext(context: AccessContext): TokenScopeGate
    {
        return TokenScopeGate.For(context instanceof ScopedAccessContext ? context.Scopes : [])
    }

    public Allows(method: string): boolean
    {
        return this.allowed === null || this.allowed.has(method)
    }
}
