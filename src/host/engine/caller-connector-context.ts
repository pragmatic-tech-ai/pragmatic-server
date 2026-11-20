import { ConnectorContext } from '@pragmatic-tech-ai/pragmatic-graph'
import { SystemPrincipal } from '@pragmatic-tech-ai/pragmatic-identity'
import type { Principal, Realm } from '@pragmatic-tech-ai/pragmatic-identity'

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

    /** The environment's system principal's context: Key = `SystemPrincipal.IdFor(realm.Id)`. */
    public static System(realm: Realm): ConnectorContext
    {
        return ConnectorContext.For(SystemPrincipal.IdFor(realm.Id))
    }
}
