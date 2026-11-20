import { SessionRecord } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { TenantRecord } from '../platform-records.js'
import { TenantSessionClaims } from './tenant-sessions.js'

/**
 * The roles the tenant admin console's routes name (stage B): the tenant role `admin` (predefined by every realm) and the
 * console's own application role `environment-admin` (declared in its component descriptor), checked by the host's
 * ClaimsAuthorizer against the `roles` and `app_roles` claims.
 */
export class TenantRoles
{
    /** The tenant role: everything the console offers (environments, access, settings, configuration). */
    public static readonly Admin = 'admin'
    /** The console's application role: the tenant's environments and their rollout, not access or settings. */
    public static readonly EnvironmentAdmin = 'environment-admin'
}

/**
 * The bridge from the tenant record to role claims, until every realm issues roles itself (stage B step 2b issues them;
 * this bridge goes with stage B step 4). It derives, per request, what the console's capabilities used to: the tenant's
 * owner (by principal id, else by email, case-insensitively) holds `admin`; every other subject of the realm holds
 * `environment-admin`. A tenant that records no owner at all fails OPEN to owner, so a pre-owner-tracking tenant is never
 * locked out of its own console (provisioning always records an owner, so only records from before owner tracking lack
 * one). An unknown tenant (deleted, or not in this console's directory) derives NO role: its sessions may only read
 * what the gate still lets through. The roles the realm issued are kept (a union).
 */
export class TenantRoleClaims
{
    /** Whether the subject is the tenant's recorded owner (see the class comment for the rules). */
    public static IsOwner(principalId: string, email: string | undefined, tenant: TenantRecord | undefined): boolean
    {
        if (tenant === undefined)
        {
            return false
        }
        if (tenant.ownerPrincipalId !== undefined)
        {
            return tenant.ownerPrincipalId === principalId
        }
        if (tenant.ownerEmail !== undefined)
        {
            return email !== undefined && tenant.ownerEmail.toLowerCase() === email.toLowerCase()
        }
        return true
    }

    /** The session with the derived roles added to the ones the realm issued (sorted, unique). */
    public static Bridged(record: SessionRecord, tenant: TenantRecord | undefined): SessionRecord
    {
        const C = TenantSessionClaims
        const owner = TenantRoleClaims.IsOwner(record.Subject, record.Claims.First(C.EmailClaim), tenant)
        const roles = new Set(record.Claims.Values(C.RolesClaim))
        const appRoles = new Set(record.Claims.Values(C.AppRolesClaim))
        if (owner)
        {
            roles.add(TenantRoles.Admin)
        }
        else if (tenant !== undefined)
        {
            appRoles.add(TenantRoles.EnvironmentAdmin)
        }
        const claims = record.Claims.With(C.RolesClaim, [...roles].sort()).With(C.AppRolesClaim, [...appRoles].sort())
        return TenantSessionClaims.WithClaims(record, claims)
    }
}
