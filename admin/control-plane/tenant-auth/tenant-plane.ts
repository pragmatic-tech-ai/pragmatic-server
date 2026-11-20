import type { TenantEventBus } from '../tenant-api/tenant-events.js'
import type { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import type { TenantConfigurationEndpoint } from '../tenant-api/tenant-configuration-endpoint.js'
import type { TenantPrincipalSessions } from './tenant-principal-sessions.js'
import type { DesktopEndpoint } from './desktop-endpoint.js'
import type { DesktopRelay } from './desktop-relay.js'
import type { ITenantOidcClients } from './tenant-oidc-clients.js'
import type { TenantSessionGate } from './tenant-session-gate.js'
import type { TenantSessions } from './tenant-sessions.js'
import type { OidcRelyingParty } from '@pragmatic-tech-ai/pragmatic-app-host'

/**
 * The composed tenant plane served by the dedicated `TenantConsoleHost`: the session layer and its gate, the OIDC sign-in
 * (the app-host relying party over the console's clients), the data API, the per-tenant event bus and the principal
 * session ender. The listener, the host -> tenant resolver and the portal bundle are supplied to the host directly.
 */
export type TenantPlane =
{
    sessions: TenantSessions
    gate: TenantSessionGate
    relyingParty: OidcRelyingParty
    clients: ITenantOidcClients
    api: TenantApiEndpoint
    events: TenantEventBus
    /** Ends a principal's sessions and sockets (an Owner reset); the host attaches its sockets to it. */
    principals: TenantPrincipalSessions
    /** The Host-independent Plexus desktop surface (`/desktop/*`); absent means those paths answer 404. */
    desktop?: DesktopEndpoint
    /** The Plexus relay to environment servers (`/desktop/relay`, a ws upgrade); absent means that upgrade is refused. */
    relay?: DesktopRelay
    /** The configuration repository's routes (`/tenant-api/configuration/*`); absent on the platform's co-hosted plane. */
    configuration?: TenantConfigurationEndpoint
}
