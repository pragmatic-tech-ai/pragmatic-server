import type { ClusterSpec, HiveRecord, RegistrySpec } from '../platform-records.js'

/**
 * The hive shape exposed to the tenant admin: identity plus cluster/registry coordinates, but NOT the
 * server-side reference names (`agentTokenRef`, `trustRootRef`) the less-trusted self-service tenant has no
 * use for. Mirrors how `TenantDto` deliberately omits the IdP refs on the tenant surface.
 */
export type HiveDto =
{
    id: string
    tenantId: string
    displayName: string
    cluster: ClusterSpec
    registry: RegistrySpec
    createdAt: string
}

/** Projects a stored HiveRecord into the tenant-facing HiveDto, dropping `agentTokenRef`/`trustRootRef`. */
export class HiveDtoMapper
{
    public static ToDto(h: HiveRecord): HiveDto
    {
        return {
            id: h.id,
            tenantId: h.tenantId,
            displayName: h.displayName,
            cluster: h.cluster,
            registry: h.registry,
            createdAt: h.createdAt
        }
    }
}
