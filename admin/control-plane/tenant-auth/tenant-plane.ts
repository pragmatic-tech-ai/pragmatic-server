import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TenantSession } from './tenant-session.js'
import type { TenantAuthEndpoint } from './tenant-auth-endpoint.js'
import type { TenantAuthGate } from './tenant-auth-gate.js'
import type { TenantEventBus } from '../tenant-api/tenant-events.js'

/**
 * The tenant-plane data API seam (`/tenant-api/*`). The host depends on this interface, not the concrete
 * endpoint: Task 5's `TenantApiEndpoint` implements it, and tests supply a stub. The gate has already resolved
 * and validated the tenant principal before `Handle` runs, so the session is trusted here.
 */
export interface ITenantApiEndpoint
{
    Handle(req: IncomingMessage, res: ServerResponse, path: string, session: TenantSession): Promise<boolean>
}

/**
 * The composed tenant plane served by the dedicated `TenantPlaneHost`: the public auth endpoint, the gate that
 * guards the data API, the data API itself, and the per-tenant event bus. The listener (its own http.Server), the
 * host→tenant resolver, and the tenant static root are supplied to `TenantPlaneHost` directly, not carried here.
 */
export type TenantPlane =
{
    endpoint: TenantAuthEndpoint
    gate: TenantAuthGate
    api: ITenantApiEndpoint
    events: TenantEventBus
    /** Whether the auth endpoint's relying-party was wired with the durable reuse/TTL secret path (production) vs the legacy path. */
    isDurable?: boolean
}
