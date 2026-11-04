import { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { ApplicationDeployProtocol, GraphProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'

/** Scopes a service token may carry that restrict which methods it can call. */
export enum TokenScope
{
    GraphContribute = 'graph-contribute',
    ApplicationDeploy = 'application-deploy',
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
        super(base.Principal, base.Tenant, base.Grants, base.Policy)
        this.Scopes = scopes
    }
}

/** Restricts the methods a credential may call by its known scopes. With no known scope the gate allows everything. */
export class TokenScopeGate
{
    private static readonly MethodsByScope: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
        [TokenScope.GraphContribute, [GraphProtocol.Contribute.method, GraphProtocol.List.method]],
        [TokenScope.ApplicationDeploy, [ApplicationDeployProtocol.Deploy.method]],
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
