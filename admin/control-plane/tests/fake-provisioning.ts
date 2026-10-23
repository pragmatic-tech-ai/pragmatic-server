import type { PlatformDirectory } from '../platform-directory.js'
import type { TenantProvisioningService, TenantProvisionInput, TenantProvisionResult } from '../tenant-provisioning-service.js'

/** Host-level stand-in for TenantProvisioningService: records into the real directory, returns a canned one-time password. */
export class FakeProvisioning
{
    public static readonly Password = 'one-time-secret'

    public readonly Calls: TenantProvisionInput[] = []

    public constructor(private readonly directory: PlatformDirectory)
    {
    }

    public async Provision(input: TenantProvisionInput): Promise<TenantProvisionResult>
    {
        this.Calls.push(input)
        const record = await this.directory.CreateProvisionedTenant({ ...input, ownerPrincipalId: 'owner', idpBaseUrl: 'https://idp.test' })
        return { record, ownerPassword: FakeProvisioning.Password }
    }

    public AsService(): TenantProvisioningService
    {
        return this as unknown as TenantProvisioningService
    }
}
