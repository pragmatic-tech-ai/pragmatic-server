import { InMemoryTenantProvisioning } from '../tenancy/tenant-registry.js'
import type { ITenantProvisioning, TenantProvisioning } from '../tenancy/tenant-provisioning.js'
import type { ServerConfig } from './server-config.js'
import { FileTenantProvisioning } from './file-tenant-provisioning.js'

export class TenantProvisioningFactory
{
    private static readonly NoSource = 'no tenant source in config'

    public static Build(config: ServerConfig, readTextFile: (path: string) => string): ITenantProvisioning
    {
        if (config.tenantsFile !== undefined)
        {
            return FileTenantProvisioning.FromText(readTextFile(config.tenantsFile))
        }
        if (config.singleTenant !== undefined)
        {
            const entries = new Map<string, TenantProvisioning>()
            entries.set(config.singleTenant.id, { displayName: config.singleTenant.displayName })
            return new InMemoryTenantProvisioning(entries)
        }
        throw new Error(TenantProvisioningFactory.NoSource)
    }
}
