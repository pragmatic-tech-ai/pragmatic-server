import type { TenantRecord } from './platform-records.js'

/** The part of a tenant record that names its Owner principal. */
export type OwnedTenant = Pick<TenantRecord, 'id' | 'ownerPrincipalId'>

/**
 * The one home of the Owner principal rule, kept dependency-light (a type import only) so the in-hive console can use it
 * without pulling in the control plane's provisioning code.
 */
export class TenantOwner
{
    /** The principal id every Owner account is seeded under when its tenant records none (control-plane and in-hive IdPs alike). */
    public static readonly DefaultPrincipalId = 'owner'

    /** The tenant's recorded Owner principal, or DefaultPrincipalId when it records none. */
    public static PrincipalOf(tenant: Pick<TenantRecord, 'ownerPrincipalId'>): string
    {
        return tenant.ownerPrincipalId ?? TenantOwner.DefaultPrincipalId
    }
}
