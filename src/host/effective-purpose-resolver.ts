import { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { EnvironmentPurpose } from '../environments/environment-purpose.js'
import { ScopedAccessContext, TokenScope } from './token-scope.js'

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
}
