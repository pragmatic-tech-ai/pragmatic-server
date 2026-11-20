import { TenantRoles } from '../tenant-auth/tenant-roles.js'
import type { TenantSession } from '../tenant-auth/tenant-sessions.js'

/** What the signed-in tenant admin may do; the server is the sole authority (its routes name the roles), the portal only reflects it. */
export type AdminCapabilities = { envs: boolean; adopt: boolean; access: boolean; settings: boolean }

export type AdminRoleCapabilities = { roleLabel: string; capabilities: AdminCapabilities }

/**
 * A session's capabilities, read from its role claims exactly as the console's routes require them (the profile reports
 * these, so the portal pre-disables what the host refuses): the tenant role `admin` holds every capability; the
 * application role `environment-admin` the environments and their rollout (envs, adopt); a session holding neither holds
 * none (reads only).
 */
export class TenantAdminCapabilities
{
    public static readonly AdminRoleLabel = 'Tenant admin'
    public static readonly EnvironmentAdminRoleLabel = 'Environment admin'
    public static readonly NoRoleLabel = 'Read only'

    public static For(session: TenantSession): AdminRoleCapabilities
    {
        const C = TenantAdminCapabilities
        if (session.roles?.includes(TenantRoles.Admin) === true)
        {
            return { roleLabel: C.AdminRoleLabel, capabilities: { envs: true, adopt: true, access: true, settings: true } }
        }
        if (session.appRoles?.includes(TenantRoles.EnvironmentAdmin) === true)
        {
            return { roleLabel: C.EnvironmentAdminRoleLabel, capabilities: { envs: true, adopt: true, access: false, settings: false } }
        }
        return { roleLabel: C.NoRoleLabel, capabilities: { envs: false, adopt: false, access: false, settings: false } }
    }
}
