import { Grant, Role, ResourceRef, ResourceKind, PresentedSecret } from '@pragmatic-tech-ai/todl-identity'
import type { Tenant } from '@pragmatic-tech-ai/todl-identity'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import type { BootstrapOptions } from '../pragmatic-server.js'

/** First-run seed of an Owner admin account. Idempotent: a second run over an existing account is a no-op.
 *  The admin password is read from the secret store by reference; it is never inlined or logged. */
export class ServerBootstrap
{
    public static async SeedAsync(pack: ServerIdentityPack, tenant: Tenant, options: BootstrapOptions): Promise<void>
    {
        const existing = await pack.Directory.Lookup(options.adminPrincipalId, tenant)
        if (existing !== null)
        {
            // Register and Grants.Save are not atomic: repair a missing Owner grant left by a crash between them.
            if (options.ownerGrant)
            {
                await ServerBootstrap.EnsureOwnerGrantAsync(pack, tenant, options)
            }
            return
        }
        const password = await pack.Secrets.Get(options.adminPasswordRef)
        if (password === null)
        {
            return
        }
        const presented = new PresentedSecret(password)
        try
        {
            await pack.Registrar.Register(tenant, options.adminEmail, options.adminPrincipalId, presented)
        }
        finally
        {
            presented.Clear()
        }
        if (options.ownerGrant)
        {
            await ServerBootstrap.EnsureOwnerGrantAsync(pack, tenant, options)
        }
    }

    private static async EnsureOwnerGrantAsync(pack: ServerIdentityPack, tenant: Tenant, options: BootstrapOptions): Promise<void>
    {
        const grants = await pack.Grants.GrantsFor(options.adminPrincipalId, tenant)
        const hasOwner = grants.some(grant => grant.Role === Role.Owner && grant.Resource.Kind === ResourceKind.Tenant && grant.Resource.TenantId === tenant.Id)
        if (!hasOwner)
        {
            await pack.Grants.Save(new Grant(options.adminPrincipalId, Role.Owner, new ResourceRef(ResourceKind.Tenant, tenant.Id, [])))
        }
    }
}
