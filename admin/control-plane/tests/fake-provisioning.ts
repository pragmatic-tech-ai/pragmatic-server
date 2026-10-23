import type { PlatformDirectory } from '../platform-directory.js'
import type { TenantProvisioningService, TenantProvisionInput, TenantProvisionResult } from '../tenant-provisioning-service.js'

/** Host-level stand-in for TenantProvisioningService: records into the real directory, returns a canned one-time password. */
export class FakeProvisioning
{
    public static readonly Password = 'one-time-secret'
    private static readonly OwnerPrincipalId = 'owner'
    private static readonly IdpBaseUrl = 'https://idp.test'

    public FailWith: Error | undefined

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

    public AsService(): TenantProvisioningService
    {
        return this as unknown as TenantProvisioningService
    }
}
