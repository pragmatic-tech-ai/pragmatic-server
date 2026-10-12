import { InMemoryTenantProvisioning } from '../tenancy/tenant-registry.js'
import type { ITenantProvisioning, TenantProvisioning } from '../tenancy/tenant-provisioning.js'
import type { ServerConfig } from './server-config.js'
import { FileTenantProvisioning } from './file-tenant-provisioning.js'

export interface TenantProvisioningResult
{
    provisioning: ITenantProvisioning
    tenantCount: number
}

export class TenantProvisioningFactory
{
    private static readonly NoSource = 'no tenant source in config'

    public static Build(config: ServerConfig, readTextFile: (path: string) => string): TenantProvisioningResult
    {
        if (config.tenantsFile !== undefined)
        {
            const file = FileTenantProvisioning.FromText(readTextFile(config.tenantsFile))
            return { provisioning: file, tenantCount: file.Count() }
        }
        if (config.singleTenant !== undefined)
        {
            const entries = new Map<string, TenantProvisioning>()
            entries.set(config.singleTenant.id, { displayName: config.singleTenant.displayName })
            const inMemory = new InMemoryTenantProvisioning(entries)
            return { provisioning: inMemory, tenantCount: 1 }
        }
        throw new Error(TenantProvisioningFactory.NoSource)
    }
}
