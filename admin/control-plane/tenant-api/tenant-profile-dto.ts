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
    hive?: { id: string; displayName: string }
    capabilities: AdminCapabilitiesDto
    ownerContact?: string
    /** The tenant's own IdP coordinates BY REFERENCE ONLY: base URL + presence flags. Never the ref strings or any secret material. */
    idp?: { baseUrl?: string; signingCaConfigured: boolean; adminTokenConfigured: boolean }
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
            capabilities: { ...caps.capabilities },
        }
        if (hive !== undefined)
        {
            dto.hive = { id: hive.id, displayName: hive.displayName }
        }
        if (session.email !== undefined)
        {
            dto.email = session.email
        }
        if (tenant?.ownerEmail !== undefined)
        {
            dto.ownerContact = tenant.ownerEmail
        }
        if (tenant !== undefined && (tenant.idpBaseUrl !== undefined || tenant.idpCaRef !== undefined || tenant.idpAdminTokenRef !== undefined))
        {
            const idp: NonNullable<TenantProfileDto['idp']> = {
                signingCaConfigured: tenant.idpCaRef !== undefined,
                adminTokenConfigured: tenant.idpAdminTokenRef !== undefined,
            }
            if (tenant.idpBaseUrl !== undefined)
            {
                idp.baseUrl = tenant.idpBaseUrl
            }
            dto.idp = idp
        }
        return dto
    }
}
