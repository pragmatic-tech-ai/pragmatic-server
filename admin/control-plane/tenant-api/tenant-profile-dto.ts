import type { HiveRecord, TenantRecord } from '../platform-records.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'
import type { AdminCapabilities, AdminRoleCapabilities } from './tenant-admin-capabilities.js'

export type AdminCapabilitiesDto = AdminCapabilities

/** The signed-in admin's profile. Never carries the session id (the bearer token). */
export type TenantProfileDto = {
    principalId: string
    email?: string
    roleLabel: string
    tenant: { id: string; displayName: string; organisation?: string }
    hive: { id: string; displayName: string }
    capabilities: AdminCapabilitiesDto
    ownerContact?: string
}

export class TenantProfileMapper
{
    public static ToDto(
        session: TenantSession,
        tenant: TenantRecord | undefined,
        hive: HiveRecord | undefined,
        organisation: string | undefined,
        caps: AdminRoleCapabilities): TenantProfileDto
    {
        const tenantPart: TenantProfileDto['tenant'] = { id: session.tenantId, displayName: tenant?.displayName ?? session.tenantId }
        if (organisation !== undefined)
        {
            tenantPart.organisation = organisation
        }
        const dto: TenantProfileDto = {
            principalId: session.principalId,
            roleLabel: caps.roleLabel,
            tenant: tenantPart,
            hive: { id: hive?.id ?? '', displayName: hive?.displayName ?? '' },
            capabilities: { ...caps.capabilities },
        }
        if (session.email !== undefined)
        {
            dto.email = session.email
        }
        if (tenant?.ownerEmail !== undefined)
        {
            dto.ownerContact = tenant.ownerEmail
        }
        return dto
    }
}
