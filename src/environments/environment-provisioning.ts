import type { BootstrapOptions, OidcServerOptions, PragmaticServerOptions } from '../pragmatic-server.js'
import type { ConnectorsPolicy } from '../host/connector-policy.js'
import type { MachinePrincipalMap } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import type { EnvironmentPurpose } from './environment-purpose.js'
import type { IdentityConfig } from '@pragmatic-tech-ai/pragmatic-identity'

export interface EnvironmentProvisioning
{
    displayName: string
    purpose?: EnvironmentPurpose
    /** A Development environment that also serves the runtime surface (a co-hosted runtime graph engine); default false. */
    runtimeCoHosted?: boolean
    bootstrap?: BootstrapOptions
    oidc?: OidcServerOptions
    connectorsPolicy?: ConnectorsPolicy
    connectors?: PragmaticServerOptions['connectors']
    connectorSecretRefs?: readonly string[]
    identity?: IdentityConfig
    machine?: MachinePrincipalMap
}

/** Source of per-environment provisioning (display name + optional bootstrap/OIDC). 5B/5C back this with a
 *  RealmConfigStore; 5A uses an in-memory map. OptionsFor returns null for an unprovisioned environment. */
export interface IEnvironmentProvisioning
{
    OptionsFor(environmentId: string): EnvironmentProvisioning | null
}
