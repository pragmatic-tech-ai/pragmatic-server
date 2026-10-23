import { randomBytes } from 'node:crypto';
import type { IdpAdminClient } from './idp-admin-client.js';
import type { IdpConnection, IIdpService } from './idp-service.js';
import type { PlatformDirectory } from './platform-directory.js';
import type { TenantRecord } from './platform-records.js';

export type TenantProvisionInput = { id: string; clientId: string; displayName: string; ownerEmail: string };

export type TenantProvisionResult = { record: TenantRecord; ownerPassword: string };

/**
 * Provisions a tenant: ensures its IdP and realm, seeds the single Owner account with a
 * one-time generated password, and persists non-secret owner/IdP metadata on the TenantRecord.
 * The password is returned once to the caller; it is never logged, stored, or put in an error.
 */
export class TenantProvisioningService
{
    private static readonly OwnerPrincipalId = 'owner';
    private static readonly PasswordBytes = 24;
    private static readonly PasswordEncoding = 'base64url';

    public constructor(
        private readonly idp: IIdpService,
        private readonly directory: PlatformDirectory,
        private readonly adminClientFactory: (conn: IdpConnection) => IdpAdminClient)
    {
    }

    public async Provision(input: TenantProvisionInput): Promise<TenantProvisionResult>
    {
        // Fail fast before any IdP mutation so a duplicate or bad-client request never orphans a realm + Owner.
        this.directory.AssertCanCreateTenant(input.id, input.clientId);
        const conn = await this.idp.EnsureForTenant(input.id, input.displayName);
        const client = this.adminClientFactory(conn);
        await client.EnsureRealm(input.id, input.displayName);
        const ownerPassword = randomBytes(TenantProvisioningService.PasswordBytes).toString(TenantProvisioningService.PasswordEncoding);
        await client.SeedAccount(input.id, {
            email: input.ownerEmail,
            principalId: TenantProvisioningService.OwnerPrincipalId,
            displayName: input.displayName,
            password: ownerPassword
        });
        // Single atomic record write as the last step, so the one-time password is never lost mid-write.
        const record = await this.directory.CreateProvisionedTenant({
            id: input.id,
            clientId: input.clientId,
            displayName: input.displayName,
            ownerEmail: input.ownerEmail,
            ownerPrincipalId: TenantProvisioningService.OwnerPrincipalId,
            idpBaseUrl: conn.baseUrl,
            idpCaRef: conn.caDir,
            idpAdminTokenRef: conn.adminTokenRef
        });
        return { record, ownerPassword };
    }
}
