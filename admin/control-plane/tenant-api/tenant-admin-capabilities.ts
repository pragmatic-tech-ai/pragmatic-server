import type { TenantRecord } from '../platform-records.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

/** What the signed-in tenant admin may do; the server is the sole authority, the portal only reflects it. */
export type AdminCapabilities = { envs: boolean; adopt: boolean; access: boolean; settings: boolean }

export type AdminRoleCapabilities = { roleLabel: string; capabilities: AdminCapabilities }

/**
 * Derives a session's admin role and capabilities from the tenant's recorded owner. A tenant that records no owner at all
 * (or an unknown tenant) fails OPEN to owner, so a pre-owner-tracking tenant is never locked out of its own admin.
 */
export class TenantAdminCapabilities
{
    public static readonly OwnerRoleLabel = 'Tenant owner'
    public static readonly AdminRoleLabel = 'Environment admin'

    public static IsOwner(session: TenantSession, tenant: TenantRecord | undefined): boolean
    {
        if (tenant === undefined)
        {
            return true
        }
        if (tenant.ownerPrincipalId !== undefined)
        {
            return tenant.ownerPrincipalId === session.principalId
        }
        if (tenant.ownerEmail !== undefined)
        {
            return tenant.ownerEmail === session.email
        }
        return true
    }

    public static For(session: TenantSession, tenant: TenantRecord | undefined): AdminRoleCapabilities
    {
        if (TenantAdminCapabilities.IsOwner(session, tenant))
        {
            return { roleLabel: TenantAdminCapabilities.OwnerRoleLabel, capabilities: { envs: true, adopt: true, access: true, settings: true } }
        }
        return { roleLabel: TenantAdminCapabilities.AdminRoleLabel, capabilities: { envs: true, adopt: true, access: false, settings: false } }
    }
}
