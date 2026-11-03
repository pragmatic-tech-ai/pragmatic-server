import { randomBytes } from 'node:crypto';
import { IdpAdminError, IdpAdminTransportError, type IdpAdminClient } from './idp-admin-client.js';
import type { IdpConnection, IIdpService } from './idp-service.js';
import { UnknownTenantError, type PlatformDirectory } from './platform-directory.js';
import type { TenantRecord } from './platform-records.js';

export type TenantProvisionInput = { id: string; clientId: string; displayName: string; ownerEmail: string };

export type TenantProvisionResult = { record: TenantRecord; ownerPassword: string };

/** A reset Owner password, returned once to the operator. */
export type OwnerPasswordReset = { ownerEmail: string; ownerPassword: string };

/** The tenant has no Owner recorded (it was created without one), so there is no account to reset. Maps to 409. */
export class OwnerNotRecordedError extends Error
{
    private static readonly ErrorName = 'OwnerNotRecordedError';
    private static readonly Message = 'This tenant has no Owner recorded (it was created without one), so there is no Owner password to reset.';

    public constructor()
    {
        super(OwnerNotRecordedError.Message);
        this.name = OwnerNotRecordedError.ErrorName;
    }
}

/** The tenant has no identity provider record to reset the Owner in. Maps to 409. */
export class TenantIdpMissingError extends Error
{
    private static readonly ErrorName = 'TenantIdpMissingError';
    private static readonly Message = 'This tenant has no identity provider on this control plane, so its Owner password cannot be reset here.';

    public constructor()
    {
        super(TenantIdpMissingError.Message);
        this.name = TenantIdpMissingError.ErrorName;
    }
}

/** The tenant's IdP has no account for the recorded Owner principal (`unknown_account`). Maps to 409. */
export class OwnerAccountMissingError extends Error
{
    private static readonly ErrorName = 'OwnerAccountMissingError';
    private static readonly Message = "The tenant's identity provider has no Owner account to reset (it may have been rebuilt). Nothing was changed.";

    public constructor()
    {
        super(OwnerAccountMissingError.Message);
        this.name = OwnerAccountMissingError.ErrorName;
    }
}

/** The tenant's IdP refused the reset (status and its error code only). Maps to 409. */
export class OwnerIdpRefusedError extends Error
{
    private static readonly ErrorName = 'OwnerIdpRefusedError';
    private static readonly Prefix = "The tenant's identity provider refused the Owner password reset (";
    private static readonly Suffix = '). Nothing was changed.';

    public constructor(cause: IdpAdminError)
    {
        super(OwnerIdpRefusedError.Prefix + cause.message + OwnerIdpRefusedError.Suffix);
        this.name = OwnerIdpRefusedError.ErrorName;
    }
}

/** The tenant's IdP could not be reached (refused, timed out). Maps to 503 (the reason is not masked). */
export class IdpUnreachableError extends Error
{
    private static readonly ErrorName = 'IdpUnreachableError';
    private static readonly Prefix = "The tenant's identity provider could not be reached (";
    private static readonly Suffix = '). Check that it is running, then retry. Nothing was changed.';

    public constructor(cause: IdpAdminTransportError)
    {
        super(IdpUnreachableError.Prefix + cause.Code + IdpUnreachableError.Suffix);
        this.name = IdpUnreachableError.ErrorName;
    }
}

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
    private static readonly NotFoundStatus = 404;
    private static readonly UnknownAccountCode = 'unknown_account';

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
        const ownerPassword = TenantProvisioningService.NewOwnerPassword();
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

    /**
     * Sets a fresh one-time Owner password in the tenant's IdP (the old one stops working at once) and returns it with the
     * Owner's email, once. Nothing is stored; the password is never logged or put in an error.
     */
    public async ResetOwnerPassword(tenantId: string): Promise<OwnerPasswordReset>
    {
        const tenant = this.directory.GetTenant(tenantId);
        if (tenant === undefined)
        {
            throw new UnknownTenantError(tenantId);
        }
        if (tenant.ownerEmail === undefined || tenant.ownerPrincipalId === undefined)
        {
            throw new OwnerNotRecordedError();
        }
        const conn = await this.idp.ConnectForTenant(tenantId);
        if (conn === undefined)
        {
            throw new TenantIdpMissingError();
        }
        const ownerPassword = TenantProvisioningService.NewOwnerPassword();
        try
        {
            await this.adminClientFactory(conn).ResetPassword(tenantId, tenant.ownerPrincipalId, ownerPassword);
        }
        catch (err)
        {
            throw TenantProvisioningService.ResetFailure(err);
        }
        return { ownerEmail: tenant.ownerEmail, ownerPassword };
    }

    /** The one generator (and strength) for Owner passwords: 24 random bytes, base64url. */
    private static NewOwnerPassword(): string
    {
        return randomBytes(TenantProvisioningService.PasswordBytes).toString(TenantProvisioningService.PasswordEncoding);
    }

    private static ResetFailure(err: unknown): unknown
    {
        if (err instanceof IdpAdminError)
        {
            return err.Status === TenantProvisioningService.NotFoundStatus && err.Code === TenantProvisioningService.UnknownAccountCode
                ? new OwnerAccountMissingError()
                : new OwnerIdpRefusedError(err);
        }
        return err instanceof IdpAdminTransportError ? new IdpUnreachableError(err) : err;
    }
}
