import { Grant, Role, ResourceRef, ResourceKind, PresentedSecret } from '@pragmatic-tech-ai/pragmatic-identity'
import type { Realm } from '@pragmatic-tech-ai/pragmatic-identity'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/pragmatic-identity-store'
import type { BootstrapOptions } from '../pragmatic-server.js'

/** First-run seed of an Owner admin account. Idempotent: a second run over an existing account is a no-op.
 *  The admin password is read from the secret store by reference; it is never inlined or logged. */
export class ServerBootstrap
{
    public static async SeedAsync(pack: ServerIdentityPack, realm: Realm, options: BootstrapOptions): Promise<void>
    {
        const existing = await pack.Directory.Lookup(options.adminPrincipalId, realm)
        if (existing !== null)
        {
            // Register and Grants.Save are not atomic: repair a missing Owner grant left by a crash between them.
            if (options.ownerGrant)
            {
                await ServerBootstrap.EnsureOwnerGrantAsync(pack, realm, options)
            }
            if (options.allowAdminPasswordRotation === true)
            {
                await ServerBootstrap.RotateAdminPasswordAsync(pack, realm, options)
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
            await pack.Registrar.Register(realm, options.adminEmail, options.adminPrincipalId, presented)
        }
        finally
        {
            presented.Clear()
        }
        if (options.ownerGrant)
        {
            await ServerBootstrap.EnsureOwnerGrantAsync(pack, realm, options)
        }
    }

    private static async EnsureOwnerGrantAsync(pack: ServerIdentityPack, realm: Realm, options: BootstrapOptions): Promise<void>
    {
        const grants = await pack.Grants.GrantsFor(options.adminPrincipalId, realm)
        const hasOwner = grants.some(grant => grant.Role === Role.Owner && grant.Resource.Kind === ResourceKind.Realm && grant.Resource.RealmId === realm.Id)
        if (!hasOwner)
        {
            await pack.Grants.Save(new Grant(options.adminPrincipalId, Role.Owner, new ResourceRef(ResourceKind.Realm, realm.Id, [])))
        }
    }

    /** Opt-in: re-hash the admin credential when the provisioned password no longer matches the stored
     *  hash. Fail-closed: a null provisioned plaintext is a no-op (never wipes the live credential). */
    private static async RotateAdminPasswordAsync(pack: ServerIdentityPack, realm: Realm, options: BootstrapOptions): Promise<void>
    {
        const password = await pack.Secrets.Get(options.adminPasswordRef)
        if (password === null)
        {
            return
        }
        const presented = new PresentedSecret(password)
        try
        {
            await pack.Registrar.RotatePasswordIfChanged(realm, options.adminPrincipalId, presented)
        }
        finally
        {
            presented.Clear()
        }
    }
}
