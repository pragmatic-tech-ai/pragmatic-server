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

/**
 * The one home of the rule for an operator Owner reset time as it crosses from the control plane to the in-hive console: the
 * control plane's record file, the advert transport reading the answer and the console's follower all accept exactly the
 * values this accepts. Kept here, dependency-free, so the follower may use it.
 */
export class OwnerResetTime
{
    /** A string that Date.parse reads as a time. */
    public static IsWellFormed(value: unknown): value is string
    {
        return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    }
}
