import { AccessContext, ScopedAccessContext, TokenScope } from '@pragmatic-tech-ai/pragmatic-identity'
import { EnvironmentPurpose } from '../environments/environment-purpose.js'

/**
 * Decides which service stack (development engine or runtime engine) one connection sees. Resolved once at
 * authentication time from how the connection authenticated, so a dual-purpose environment computes exactly one stack
 * per connection. A develop connection must never reach the runtime stack.
 */
export class EffectivePurposeResolver
{
    /**
     * Browser-cookie (served app) sessions and RunTest-scoped tokens are Runtime; Develop-scoped tokens are Development;
     * anything else (an unscoped platform/admin session) keeps the environment's own purpose.
     */
    public static Resolve(context: AccessContext, viaCookie: boolean, server: { Purpose(): EnvironmentPurpose }): EnvironmentPurpose
    {
        if (viaCookie)
        {
            // A cookie connection on a PURE Development env (not runtimeCoHosted) intentionally resolves to Runtime and so gets an
            // empty service stack. Unreachable in practice: a pure dev env exposes no AppServingEndpoint/applications registry, so no
            // browser-login cookie session exists (the authoring client uses a bearer Develop token).
            return EnvironmentPurpose.Runtime
        }
        if (context instanceof ScopedAccessContext)
        {
            if (context.Scopes.includes(TokenScope.RunTest))
            {
                return EnvironmentPurpose.Runtime
            }
            if (context.Scopes.includes(TokenScope.Develop))
            {
                return EnvironmentPurpose.Development
            }
        }
        return server.Purpose()
    }

    /** Pairs a resolved context (or null for a failed authentication) with its effective purpose. */
    public static ResolveAuthenticated(context: AccessContext | null, viaCookie: boolean, server: { Purpose(): EnvironmentPurpose }): { context: AccessContext; effectivePurpose: EnvironmentPurpose } | null
    {
        return context === null ? null : { context, effectivePurpose: EffectivePurposeResolver.Resolve(context, viaCookie, server) }
    }
}
