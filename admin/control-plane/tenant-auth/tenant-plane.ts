import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TenantSession } from './tenant-session.js'
import type { TenantAuthEndpoint } from './tenant-auth-endpoint.js'
import type { TenantAuthGate } from './tenant-auth-gate.js'

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
 * The composed tenant plane mounted into the control-plane host: the public auth endpoint, the gate that guards
 * the data API, the data API itself, and the set of hosts whose origin the tenant surface accepts. It is an
 * optional, separable plane; when absent the host serves the operator surface exactly as before.
 */
export type TenantPlane =
{
    endpoint: TenantAuthEndpoint
    gate: TenantAuthGate
    api: ITenantApiEndpoint
    allowedHosts: ReadonlySet<string>
}
