import type { PlatformDirectory } from '../platform-directory.js'
import type { OwnerPasswordReset, TenantProvisioningService, TenantProvisionInput, TenantProvisionResult } from '../tenant-provisioning-service.js'
import { UnknownTenantError } from '../platform-directory.js'

/** Host-level stand-in for TenantProvisioningService: records into the real directory, returns a canned one-time password. */
export class FakeProvisioning
{
    public static readonly Password = 'one-time-secret'
    public static readonly ResetPassword = 'reset-one-time-secret-Zq9'
    private static readonly OwnerPrincipalId = 'owner'
    private static readonly IdpBaseUrl = 'https://idp.test'

    public FailWith: Error | undefined
    public ResetFailWith: Error | undefined
    // When set, the reset reports that the Owner's sessions could not be ended, with this warning.
    public ResetWarning: string | undefined
    public readonly Resets: string[] = []
    public readonly Forgotten: string[] = []

    public readonly Calls: TenantProvisionInput[] = []

    public constructor(private readonly directory: PlatformDirectory)
    {
    }

    public async Provision(input: TenantProvisionInput): Promise<TenantProvisionResult>
    {
        this.Calls.push(input)
        if (this.FailWith !== undefined)
        {
            throw this.FailWith
        }
        const record = await this.directory.CreateProvisionedTenant({ ...input, ownerPrincipalId: FakeProvisioning.OwnerPrincipalId, idpBaseUrl: FakeProvisioning.IdpBaseUrl })
        return { record, ownerPassword: FakeProvisioning.Password }
    }

    public async ResetOwnerPassword(tenantId: string): Promise<OwnerPasswordReset>
    {
        const tenant = this.directory.GetTenant(tenantId)
        if (tenant === undefined)
        {
            throw new UnknownTenantError(tenantId)
        }
        if (this.ResetFailWith !== undefined)
        {
            throw this.ResetFailWith
        }
        this.Resets.push(tenantId)
        const reset: OwnerPasswordReset = { ownerEmail: tenant.ownerEmail ?? '', ownerPassword: FakeProvisioning.ResetPassword, sessionsRevoked: this.ResetWarning === undefined }
        if (this.ResetWarning !== undefined)
        {
            reset.warning = this.ResetWarning
        }
        return reset
    }

    public async ForgetTenant(tenantId: string): Promise<void>
    {
        this.Forgotten.push(tenantId)
    }

    public AsService(): TenantProvisioningService
    {
        return this as unknown as TenantProvisioningService
    }
}
