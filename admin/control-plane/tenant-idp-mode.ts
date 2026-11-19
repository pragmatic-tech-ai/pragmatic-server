/**
 * Where a tenant's sign-in runs. Central: the platform runs the tenant's IdP and seeds its Owner with a one-time password.
 * InHive: the tenant is a record only (client, tenant, Owner email); its console and sign-in are installed into its home
 * hive, so the platform starts no IdP and holds no password.
 */
export enum TenantIdpMode
{
    Central = 'central',
    InHive = 'in-hive',
}

/** A platform-created environment for a tenant whose sign-in lives in its hive: create it in the hive's console. Maps to 409. */
export class TenantSignInInHiveError extends Error
{
    private static readonly ErrorName = 'TenantSignInInHiveError'
    private static readonly Message = 'This tenant signs in through its own hive; create environments in its console'

    public constructor()
    {
        super(TenantSignInInHiveError.Message)
        this.name = TenantSignInInHiveError.ErrorName
    }
}
