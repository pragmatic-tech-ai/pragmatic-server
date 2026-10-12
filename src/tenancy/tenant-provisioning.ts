import type { BootstrapOptions, OidcServerOptions, PragmaticServerOptions } from '../pragmatic-server.js'
import type { ConnectorsPolicy } from '../host/connector-policy.js'

export interface TenantProvisioning
{
    displayName: string
    bootstrap?: BootstrapOptions
    oidc?: OidcServerOptions
    connectorsPolicy?: ConnectorsPolicy
    connectors?: PragmaticServerOptions['connectors']
    connectorSecretRefs?: readonly string[]
}

/** Source of per-tenant provisioning (display name + optional bootstrap/OIDC). 5B/5C back this with a
 *  TenantConfigStore; 5A uses an in-memory map. OptionsFor returns null for an unprovisioned tenant. */
export interface ITenantProvisioning
{
    OptionsFor(tenantId: string): TenantProvisioning | null
}
