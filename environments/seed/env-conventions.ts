import type { EnvDefinition } from './bundle.js'

/**
 * The names and routes every environment backend agrees on, independent of how it runs: the resource names derived from
 * an environment definition (container, volume, network and database names on a dev box; the database host a template
 * writes into a bundle) and the env server's health route (probed by Docker and by the in-cluster manifests alike).
 */
export class EnvConventions
{
    /** The prefix every environment resource name starts with. */
    public static readonly NamePrefix = 'pragmatic-env-'
    private static readonly VolumeSuffix = '-data'
    private static readonly NetworkSuffix = '-net'
    private static readonly DbSuffix = '-db'
    private static readonly DbVolumeSuffix = '-db-data'
    public static readonly HealthPath = '/healthz'

    public static ContainerName(def: EnvDefinition): string
    {
        return `${EnvConventions.NamePrefix}${def.name}`
    }

    public static VolumeName(def: EnvDefinition): string
    {
        return `${EnvConventions.NamePrefix}${def.name}${EnvConventions.VolumeSuffix}`
    }

    public static NetworkName(def: EnvDefinition): string
    {
        return `${EnvConventions.NamePrefix}${def.name}${EnvConventions.NetworkSuffix}`
    }

    public static DbContainerName(def: EnvDefinition): string
    {
        return `${EnvConventions.NamePrefix}${def.name}${EnvConventions.DbSuffix}`
    }

    public static DbVolumeName(def: EnvDefinition): string
    {
        return `${EnvConventions.NamePrefix}${def.name}${EnvConventions.DbVolumeSuffix}`
    }
}
