import type { HiveBackend, HiveRecord, InfraMode } from '../platform-records.js'

/** The hive's cluster coordinates exposed to a tenant: backend and mode only — no `configRef`. */
export type TenantClusterDto =
{
    backend: HiveBackend
    mode: InfraMode
}

/** The hive's registry coordinates exposed to a tenant: mode and (optional) endpoint only — no `credentialRef`. */
export type TenantRegistryDto =
{
    mode: InfraMode
    endpoint?: string
}

/**
 * The hive shape exposed to the tenant admin: identity plus coordinate-only cluster/registry info, carrying NO
 * server-side reference names (`agentTokenRef`, `trustRootRef`, `configRef`, `credentialRef`) the less-trusted
 * self-service tenant has no use for. Mirrors how `TenantDto` deliberately omits the IdP refs on the tenant surface.
 */
export type HiveDto =
{
    id: string
    tenantId: string
    displayName: string
    cluster: TenantClusterDto
    registry: TenantRegistryDto
    createdAt: string
}

/**
 * Projects a stored HiveRecord into the tenant-facing HiveDto. Every field is copied explicitly (the cluster and
 * registry specs are NOT spread) so a reference field added to those specs in future can never silently leak onto
 * the tenant surface — it would have to be added here deliberately.
 */
export class HiveDtoMapper
{
    public static ToDto(h: HiveRecord): HiveDto
    {
        return {
            id: h.id,
            tenantId: h.tenantId,
            displayName: h.displayName,
            cluster: { backend: h.cluster.backend, mode: h.cluster.mode },
            registry: { mode: h.registry.mode, endpoint: h.registry.endpoint },
            createdAt: h.createdAt
        }
    }
}
