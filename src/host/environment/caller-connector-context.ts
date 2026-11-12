import { ConnectorContext } from '@pragmatic-tech-ai/graph'
import { SystemPrincipal } from '@pragmatic-tech-ai/todl-identity'
import type { Principal, Tenant } from '@pragmatic-tech-ai/todl-identity'

/**
 * The engine ConnectorContext a server call runs its connector work under (spec section 6, PR12). The key is the acting
 * principal's id: TODL, connectors-host and the engine see only that opaque key, never an identity type. User-started
 * work passes the caller's ({@link CallerConnectorContext.For}), background work the environment's system principal's
 * ({@link CallerConnectorContext.System}).
 */
export class CallerConnectorContext
{
    /** The caller's context: Key = the principal id. */
    public static For(principal: Principal): ConnectorContext
    {
        return ConnectorContext.For(principal.Id)
    }

    /** The environment's system principal's context: Key = `SystemPrincipal.IdFor(tenant.Id)`. */
    public static System(tenant: Tenant): ConnectorContext
    {
        return ConnectorContext.For(SystemPrincipal.IdFor(tenant.Id))
    }
}
