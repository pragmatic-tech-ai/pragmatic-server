import { randomBytes } from 'node:crypto';
import { IdpAdminError, IdpAdminTransportError, type IdpAdminClient } from './idp-admin-client.js';
import type { IdpConnection, IIdpService } from './idp-service.js';
import { UnknownTenantError, type PlatformDirectory } from './platform-directory.js';
import type { TenantRecord } from './platform-records.js';
import type { TenantAccountIndex } from './tenant-account-index.js';

export type TenantProvisionInput = { id: string; clientId: string; displayName: string; ownerEmail: string };

export type TenantProvisionResult = { record: TenantRecord; ownerPassword: string };

/**
 * A reset Owner password, returned once to the operator. `sessionsRevoked` is false when the password changed but the
 * Owner's existing tenant-portal sessions could not be ended; `warning` then says so.
 */
export type OwnerPasswordReset = { ownerEmail: string; ownerPassword: string; sessionsRevoked: boolean; warning?: string };

/** Ends a tenant principal's tenant-portal sessions (host-free: no tenant-plane types). */
export interface IOwnerSessionRevoker
{
    RevokeAllFor(tenantId: string, principalId: string): Promise<void>;
}

/** A reset of this tenant's Owner password is already running. Maps to 409. */
export class OwnerResetInProgressError extends Error
{
    private static readonly ErrorName = 'OwnerResetInProgressError';
    private static readonly Message = "This tenant's Owner password is already being reset. Wait for it to finish, then reset again if needed.";

    public constructor()
    {
        super(OwnerResetInProgressError.Message);
        this.name = OwnerResetInProgressError.ErrorName;
    }
}

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
    private static readonly Message = "This tenant's identity provider is not managed by this control plane, so its Owner password cannot be reset here. Reset it from within the tenant's cluster, through that identity provider's admin password reset.";

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
    private static readonly NotSentSuffix = '). Check that it is running, then retry. Nothing was changed.';
    private static readonly MaybeAppliedSuffix = '). The reset may have been applied: reset again to get a working password.';
    /** Failures before the request could reach the IdP (connect refused, name or route not found): nothing was sent. */
    private static readonly NotSentCodes: ReadonlySet<string> = new Set([
        'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
        // TLS handshake failures: the connection is refused before any request bytes are sent.
        'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED',
        'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE', 'ERR_SSL_WRONG_VERSION_NUMBER',
    ]);

    public constructor(cause: IdpAdminTransportError)
    {
        super(IdpUnreachableError.Prefix + cause.Code
            + (IdpUnreachableError.NotSentCodes.has(cause.Code) ? IdpUnreachableError.NotSentSuffix : IdpUnreachableError.MaybeAppliedSuffix));
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
    private static readonly SessionsNotEndedWarning = "The new password is set, but the Owner's existing sessions could not be ended durably: they may return after a control-plane restart, until they expire (up to 12 hours).";
    private static readonly LogPrefix = '[owner-reset] tenant ';
    private static readonly LogSessionsInfix = ': ending the Owner sessions failed: ';
    private static readonly UnknownErrorName = 'Error';
    private static readonly IndexFailurePrefix = '[account-index] tenant ';
    private static readonly IndexFailureInfix = ': indexing the Owner failed (the startup back-fill will retry): ';

    /** Tenants with an Owner password reset in flight (one at a time per tenant). */
    private readonly resetting = new Set<string>();

    public constructor(
        private readonly idp: IIdpService,
        private readonly directory: PlatformDirectory,
        private readonly adminClientFactory: (conn: IdpConnection) => IdpAdminClient,
        /** Ends the Owner's tenant-portal sessions after a reset; absent where no tenant plane runs. */
        private readonly sessions?: IOwnerSessionRevoker,
        /** The email-discovery index every account created here must be recorded in (see TenantAccountIndex). */
        private readonly accounts?: TenantAccountIndex)
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
        await this.IndexOwner(record);
        return { record, ownerPassword };
    }

    /** Drops a deleted tenant's accounts from the discovery index. */
    public async ForgetTenant(tenantId: string): Promise<void>
    {
        await this.accounts?.ForgetTenant(tenantId);
    }

    /**
     * Records the seeded Owner for email discovery. The tenant and its one-time password already exist, so an index failure
     * must not fail the provision (the password would be lost); the startup back-fill indexes the Owner on the next restart.
     */
    private async IndexOwner(record: TenantRecord): Promise<void>
    {
        if (this.accounts === undefined || record.ownerEmail === undefined || record.ownerPrincipalId === undefined)
        {
            return;
        }
        try
        {
            await this.accounts.Record(record.id, record.ownerPrincipalId, record.ownerEmail);
        }
        catch (err)
        {
            console.error(TenantProvisioningService.IndexFailurePrefix + record.id + TenantProvisioningService.IndexFailureInfix
                + (err instanceof Error ? err.name : TenantProvisioningService.UnknownErrorName));
        }
    }

    /**
     * Sets a fresh one-time Owner password in the tenant's IdP (the old one stops working at once) and returns it with the
     * Owner's email, once. Nothing is stored; the password is never logged or put in an error.
     */
    public async ResetOwnerPassword(tenantId: string): Promise<OwnerPasswordReset>
    {
        if (this.resetting.has(tenantId))
        {
            throw new OwnerResetInProgressError();
        }
        this.resetting.add(tenantId);
        try
        {
            return await this.ResetOwnerPasswordOnce(tenantId);
        }
        finally
        {
            this.resetting.delete(tenantId);
        }
    }

    private async ResetOwnerPasswordOnce(tenantId: string): Promise<OwnerPasswordReset>
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
        // The password changed (the IdP also ended the Owner's SSO sessions): end the tenant-portal sessions too.
        const reset: OwnerPasswordReset = { ownerEmail: tenant.ownerEmail, ownerPassword, sessionsRevoked: true };
        try
        {
            await this.sessions?.RevokeAllFor(tenantId, tenant.ownerPrincipalId);
        }
        catch (err)
        {
            console.error(TenantProvisioningService.LogPrefix + tenantId + TenantProvisioningService.LogSessionsInfix
                + (err instanceof Error ? err.name : TenantProvisioningService.UnknownErrorName));
            reset.sessionsRevoked = false;
            reset.warning = TenantProvisioningService.SessionsNotEndedWarning;
        }
        return reset;
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
