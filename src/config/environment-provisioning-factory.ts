import { InMemoryEnvironmentProvisioning } from '../environments/environment-registry.js'
import type { IEnvironmentProvisioning, EnvironmentProvisioning } from '../environments/environment-provisioning.js'
import type { ServerConfig } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { FileEnvironmentProvisioning } from './file-environment-provisioning.js'

export interface EnvironmentProvisioningResult
{
    provisioning: IEnvironmentProvisioning
    environmentCount: number
}

export class EnvironmentProvisioningFactory
{
    private static readonly NoSource = 'no environment source in config'

    public static Build(config: ServerConfig, readTextFile: (path: string) => string): EnvironmentProvisioningResult
    {
        if (config.environmentsFile !== undefined)
        {
            const file = FileEnvironmentProvisioning.FromText(readTextFile(config.environmentsFile))
            return { provisioning: file, environmentCount: file.Count() }
        }
        if (config.singleEnvironment !== undefined)
        {
            const entries = new Map<string, EnvironmentProvisioning>()
            entries.set(config.singleEnvironment.id, { displayName: config.singleEnvironment.displayName })
            const inMemory = new InMemoryEnvironmentProvisioning(entries)
            return { provisioning: inMemory, environmentCount: 1 }
        }
        throw new Error(EnvironmentProvisioningFactory.NoSource)
    }
}
