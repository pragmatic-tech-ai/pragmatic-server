import type { ServerConfig } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { type IProvisionedSecretSource, ProvisionedSecretSource } from './provisioned-secret-source.js'

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
