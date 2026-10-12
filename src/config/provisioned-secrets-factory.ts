import type { ServerConfig } from './server-config.js'
import type { IProvisionedSecretSource } from './provisioned-secret-source.js'
import { ProvisionedSecretSource } from './provisioned-secret-source.js'

/** Builds the provisioned-secret source from the configured file, or undefined when none is configured. */
export class ProvisionedSecretsFactory
{
    public static Build(config: ServerConfig, readTextFile: (path: string) => string): IProvisionedSecretSource | undefined
    {
        if (config.provisionedSecretsFile === undefined || config.provisionedSecretsFile.length === 0)
        {
            return undefined
        }
        return ProvisionedSecretSource.FromText(readTextFile(config.provisionedSecretsFile))
    }
}
